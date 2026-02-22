#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, readFile, stat, utimes, writeFile } from 'fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import chokidar, { type FSWatcher } from 'chokidar';
import cliProgress from 'cli-progress';
import { glob } from 'glob';
import yaml from 'js-yaml';
import { minimatch } from 'minimatch';
import pLimit from 'p-limit';
import { Renderer } from '../src/renderer.js';
import {
  cleanRuntimeAssets,
  installRuntimeAssets,
  resolveAssetCacheDir,
  verifyRuntimeAssets
} from '../src/assets/manager.js';
import type { AssetMode, OutputFormat, RendererOptions } from '../src/types.js';
import { normalizeMaxConcurrentPages, normalizeTocDepth } from '../src/utils/validation.js';
import { ensureError, ignoreError, isErrnoException, toErrorMessage } from '../src/utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 32;
const CONFIG_FILE_CANDIDATES = [
  '.convpdfrc',
  '.convpdfrc.json',
  '.convpdfrc.yaml',
  '.convpdfrc.yml'
];

const findPackageJson = async (dir: string): Promise<string> => {
  const candidate = join(dir, 'package.json');
  try {
    await stat(candidate);
    return candidate;
  } catch {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('package.json not found');
    }
    return findPackageJson(parent);
  }
};

const pkg = JSON.parse(await readFile(await findPackageJson(__dirname), 'utf-8')) as {
  version: string;
};

interface CliOptions {
  output?: string;
  watch?: boolean;
  css?: string;
  template?: string;
  margin?: string;
  format?: RendererOptions['format'];
  header?: string;
  footer?: string;
  toc?: boolean;
  tocDepth?: number;
  executablePath?: string;
  maxPages?: number;
  preserveTimestamp?: boolean;
  concurrency?: number;
  outputFormat?: OutputFormat;
  html?: boolean;
  assetMode?: AssetMode;
  assetCacheDir?: string;
  assetFallback?: boolean;
}

interface ConfigFile extends RendererOptions {
  header?: string;
  footer?: string;
  css?: string;
  output?: string;
  watch?: boolean;
  preserveTimestamp?: boolean;
  concurrency?: number;
  maxConcurrentPages?: number;
  outputFormat?: OutputFormat;
}

interface LoadedConfig {
  values: ConfigFile;
  sourcePath: string | null;
}

type OutputMode = 'adjacent' | 'directory' | 'single-file';

interface OutputStrategy {
  mode: OutputMode;
  targetPath: string | null;
  outputFormat: OutputFormat;
}

interface InputDescriptor {
  raw: string;
  absolute: string;
  kind: 'file' | 'directory' | 'pattern';
}

interface RuntimeCliOptions extends ConfigFile {
  html?: boolean;
  maxPages?: number;
}

interface AssetsCommandOptions {
  cacheDir?: string;
  force?: boolean;
  json?: boolean;
}

const MAX_WATCH_RETRIES = 5;
const WATCH_RETRY_BASE_MS = 200;

class ConversionQueue {
  private inFlight = new Set<string>();
  private needsRerun = new Set<string>();

  constructor(private limit: ReturnType<typeof pLimit>) {}

  enqueue(filePath: string, convert: (file: string) => Promise<void>): void {
    if (this.inFlight.has(filePath)) {
      this.needsRerun.add(filePath);
      return;
    }

    this.inFlight.add(filePath);
    void this.limit(async () => {
      let consecutiveFailures = 0;
      try {
        do {
          this.needsRerun.delete(filePath);
          try {
            await convert(filePath);
            consecutiveFailures = 0;
          } catch {
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_WATCH_RETRIES && !this.needsRerun.has(filePath)) {
              console.error(
                chalk.yellow(
                  `Skipping "${filePath}" after ${consecutiveFailures} consecutive failures.`
                )
              );
              break;
            }
            if (this.needsRerun.has(filePath)) {
              const backoffMs = Math.min(
                WATCH_RETRY_BASE_MS * 2 ** (consecutiveFailures - 1),
                5000
              );
              await new Promise<void>((r) => {
                setTimeout(r, backoffMs);
              });
            }
          }
        } while (this.needsRerun.has(filePath));
      } finally {
        this.needsRerun.delete(filePath);
        this.inFlight.delete(filePath);
      }
    });
  }
}

const normalizeAssetMode = (mode: unknown): AssetMode => {
  if (typeof mode !== 'string') {
    throw new Error(`Invalid asset mode "${String(mode)}". Expected auto, local, or cdn.`);
  }
  const normalized = mode.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'local' || normalized === 'cdn') {
    return normalized;
  }
  throw new Error(`Invalid asset mode "${mode}". Expected auto, local, or cdn.`);
};

const parseAssetsCommandArgs = (
  args: string[]
): { operation: string; options: AssetsCommandOptions } => {
  const [operation, ...rest] = args;
  if (!operation) {
    throw new Error('Missing assets operation. Use: install, verify, update, or clean.');
  }

  const options: AssetsCommandOptions = {};
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (!arg) continue;

    if (arg === '--cache-dir') {
      const value = rest[index + 1];
      if (!value) {
        throw new Error('Missing value for --cache-dir');
      }
      options.cacheDir = resolve(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--cache-dir=')) {
      const value = arg.slice('--cache-dir='.length).trim();
      if (!value) {
        throw new Error('Missing value for --cache-dir');
      }
      options.cacheDir = resolve(value);
      continue;
    }

    if (arg === '--force') {
      options.force = true;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    throw new Error(`Unknown assets option: ${arg}`);
  }

  return { operation: operation.toLowerCase(), options };
};

const runAssetsCommand = async (args: string[]): Promise<void> => {
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: convpdf assets <install|verify|update|clean> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --cache-dir <path>  Runtime asset cache directory override');
    console.log('  --force             Force reinstall for install/update');
    console.log('  --json              Emit machine-readable JSON output');
    return;
  }

  const { operation, options } = parseAssetsCommandArgs(args);
  const cacheDir = options.cacheDir;
  const cacheRoot = resolveAssetCacheDir(cacheDir);
  const print = (jsonValue: object, textValue: string): void => {
    if (options.json) {
      console.log(JSON.stringify(jsonValue));
      return;
    }
    console.log(chalk.green(textValue));
  };

  switch (operation) {
    case 'install': {
      const result = await installRuntimeAssets(cacheDir, options.force ?? false);
      print(
        { operation, ...result, cacheDir: cacheRoot },
        result.installed
          ? `Assets installed at ${result.runtimeDir}`
          : `Assets already installed at ${result.runtimeDir}`
      );
      return;
    }
    case 'verify': {
      const paths = await verifyRuntimeAssets(cacheDir);
      print(
        { operation, ok: true, runtimeDir: paths.runtimeDir },
        `Assets verified at ${paths.runtimeDir}`
      );
      return;
    }
    case 'update': {
      const result = await installRuntimeAssets(cacheDir, true);
      print(
        { operation, ...result, cacheDir: cacheRoot },
        `Assets refreshed at ${result.runtimeDir}`
      );
      return;
    }
    case 'clean':
      await cleanRuntimeAssets(cacheDir);
      print({ operation, cleaned: true, cacheDir: cacheRoot }, `Assets removed from ${cacheRoot}`);
      return;
    default:
      throw new Error(
        `Unknown assets operation "${operation}". Use: install, verify, update, or clean.`
      );
  }
};

const hasGlobMagic = (value: string): boolean => /[*?[\]{}]/.test(value);

const getGlobParent = (pattern: string): string => {
  let current = pattern;
  while (current.endsWith('/') || current.endsWith('\\')) {
    current = current.slice(0, -1);
  }
  while (hasGlobMagic(current) && current !== dirname(current)) {
    current = dirname(current);
  }
  return resolve(current);
};

const isCaseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';
const toPosixPath = (value: string): string => value.split('\\').join('/');
const pathIsWithin = (basePath: string, targetPath: string): boolean => {
  const relPath = relative(basePath, targetPath);
  if (!relPath) return true;
  return !relPath.startsWith('..') && !/^(?:[a-zA-Z]:)?[/\\]/.test(relPath);
};

const findBasePathForFile = (absoluteFilePath: string, inputs: InputDescriptor[]): string => {
  const parents = inputs.map((input) => {
    if (input.kind === 'directory') return input.absolute;
    if (input.kind === 'pattern') return getGlobParent(input.raw);
    return dirname(input.absolute);
  });

  const uniqueParents = [...new Set(parents.map((parent) => resolve(parent)))].sort(
    (a, b) => b.length - a.length
  );

  for (const parent of uniqueParents) {
    if (pathIsWithin(parent, absoluteFilePath)) {
      return parent;
    }
  }

  return dirname(absoluteFilePath);
};

const parseInteger = (raw: string): number => {
  const normalized = raw.trim();
  if (!/^[+-]?\d+$/.test(normalized)) {
    throw new Error(`Invalid integer "${raw}"`);
  }
  return Number.parseInt(normalized, 10);
};

const normalizeConcurrency = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid concurrency value "${String(value)}". Expected an integer >= 1.`);
  }
  if (value > MAX_CONCURRENCY) {
    throw new Error(
      `Invalid concurrency value "${String(value)}". Expected an integer between 1 and ${MAX_CONCURRENCY}.`
    );
  }
  return value;
};

const normalizeOutputFormat = (format: unknown): OutputFormat => {
  if (typeof format !== 'string') {
    throw new Error(`Invalid output format "${String(format)}". Expected "pdf" or "html".`);
  }
  const normalized = format.trim().toLowerCase();
  if (normalized === 'pdf' || normalized === 'html') {
    return normalized;
  }
  throw new Error(`Invalid output format "${format}". Expected "pdf" or "html".`);
};

const normalizeConfigPaths = (config: ConfigFile, configPath: string): ConfigFile => {
  const configDir = dirname(configPath);
  const normalized = { ...config };
  if (normalized.css) normalized.css = resolve(configDir, normalized.css);
  if (normalized.template) normalized.template = resolve(configDir, normalized.template);
  if (normalized.header) normalized.header = resolve(configDir, normalized.header);
  if (normalized.footer) normalized.footer = resolve(configDir, normalized.footer);
  if (normalized.output) normalized.output = resolve(configDir, normalized.output);
  if (normalized.assetCacheDir)
    normalized.assetCacheDir = resolve(configDir, normalized.assetCacheDir);
  return normalized;
};

const loadConfig = async (): Promise<LoadedConfig> => {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const configPath = resolve(candidate);
    try {
      const raw = await readFile(configPath, 'utf-8');
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });

      if (!parsed) {
        return { values: {}, sourcePath: configPath };
      }
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Expected object at root of config, got ${typeof parsed}`);
      }

      const config = parsed as ConfigFile;

      if (config.assetMode !== undefined) {
        config.assetMode = normalizeAssetMode(config.assetMode);
      }

      return {
        values: normalizeConfigPaths(config, configPath),
        sourcePath: configPath
      };
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      if (isErrnoException(error) && error.code === 'ENOENT') {
        continue;
      }
      throw new Error(
        `Failed to parse config "${relative(process.cwd(), configPath)}": ${message}`,
        {
          cause: error
        }
      );
    }
  }

  return { values: {}, sourcePath: null };
};

const resolveRuntimeOptions = (config: ConfigFile, cliOptions: CliOptions): RuntimeCliOptions => {
  const definedCliOptions = Object.fromEntries(
    Object.entries(cliOptions).filter(([, value]) => value !== undefined)
  ) as Partial<CliOptions>;
  const { assetFallback, ...remainingCliOptions } = definedCliOptions;
  const merged: RuntimeCliOptions = { ...config, ...remainingCliOptions };

  if (assetFallback !== undefined) {
    merged.allowNetworkFallback = assetFallback;
  }

  const outputFormat = normalizeOutputFormat(merged.outputFormat ?? 'pdf');
  merged.outputFormat = merged.html ? 'html' : outputFormat;
  if (merged.tocDepth !== undefined) {
    merged.tocDepth = normalizeTocDepth(merged.tocDepth);
  }
  if (merged.assetMode !== undefined) {
    merged.assetMode = normalizeAssetMode(merged.assetMode);
  }
  if (merged.maxConcurrentPages !== undefined) {
    merged.maxConcurrentPages = normalizeMaxConcurrentPages(merged.maxConcurrentPages);
  }
  if (merged.maxPages !== undefined) {
    merged.maxConcurrentPages = normalizeMaxConcurrentPages(merged.maxPages);
  }
  if (merged.concurrency !== undefined) {
    merged.concurrency = normalizeConcurrency(merged.concurrency);
  }
  return merged;
};

const describeInputs = async (inputs: string[]): Promise<InputDescriptor[]> =>
  Promise.all(
    inputs.map(async (raw) => {
      const absolute = resolve(raw);
      try {
        const stats = await stat(absolute);
        if (stats.isFile()) {
          return {
            raw,
            absolute,
            kind: 'file'
          };
        }
        if (stats.isDirectory()) {
          return {
            raw,
            absolute,
            kind: 'directory'
          };
        }
        return {
          raw,
          absolute,
          kind: hasGlobMagic(raw) ? 'pattern' : 'file'
        };
      } catch {
        return {
          raw,
          absolute,
          kind: hasGlobMagic(raw) ? 'pattern' : 'file'
        };
      }
    })
  );

const resolveMarkdownFiles = async (inputs: InputDescriptor[]): Promise<string[]> => {
  const matches = await Promise.all(
    inputs.map(async (input) => {
      if (input.kind === 'file') {
        try {
          const stats = await stat(input.absolute);
          if (stats.isFile()) return [input.absolute];
        } catch {
          // Missing files are allowed when running in watch mode.
        }
        return [];
      }

      if (input.kind === 'directory') {
        try {
          return glob('**/*.{md,markdown}', {
            cwd: input.absolute,
            nodir: true,
            absolute: true
          });
        } catch {
          return [];
        }
      }

      return glob(input.raw, { nodir: true, absolute: true });
    })
  );

  return [
    ...new Set(matches.flat().filter((pathValue) => /\.(md|markdown)$/i.test(pathValue)))
  ].sort((a, b) => a.localeCompare(b));
};

const createInputMatcher = (inputs: InputDescriptor[]): ((candidatePath: string) => boolean) => {
  const explicitFiles = new Set(
    inputs
      .filter((input) => input.kind === 'file')
      .map((input) => (isCaseInsensitiveFs ? input.absolute.toLowerCase() : input.absolute))
  );
  const directories = inputs
    .filter((input) => input.kind === 'directory')
    .map((input) => input.absolute);
  const patternMatchers = inputs
    .filter((input) => input.kind === 'pattern')
    .map((input) => toPosixPath(resolve(input.raw)));

  return (candidatePath: string): boolean => {
    const absoluteCandidate = resolve(candidatePath);
    const normalizedCandidate = isCaseInsensitiveFs
      ? absoluteCandidate.toLowerCase()
      : absoluteCandidate;

    if (explicitFiles.has(normalizedCandidate)) return true;
    if (directories.some((directoryPath) => pathIsWithin(directoryPath, absoluteCandidate))) {
      return true;
    }

    const posixCandidate = toPosixPath(absoluteCandidate);
    return patternMatchers.some((pattern) =>
      minimatch(posixCandidate, pattern, {
        dot: true,
        nocase: isCaseInsensitiveFs,
        windowsPathsNoEscape: true
      })
    );
  };
};

const resolveOutputStrategy = (
  outputPath: string | undefined,
  inputs: InputDescriptor[],
  outputFormat: OutputFormat
): OutputStrategy => {
  if (!outputPath) {
    return { mode: 'adjacent', targetPath: null, outputFormat };
  }

  const absoluteOutput = resolve(outputPath);
  if (!absoluteOutput.toLowerCase().endsWith(`.${outputFormat}`)) {
    return { mode: 'directory', targetPath: absoluteOutput, outputFormat };
  }

  const maybeMultiple = inputs.length > 1 || inputs.some((input) => input.kind !== 'file');
  if (maybeMultiple) {
    throw new Error(
      `Output path cannot be a single .${outputFormat} file when inputs can expand to multiple markdown files.`
    );
  }

  return { mode: 'single-file', targetPath: absoluteOutput, outputFormat };
};

const toOutputPath = (inputPath: string, strategy: OutputStrategy, basePath?: string): string => {
  const outputExtension = `.${strategy.outputFormat}`;
  if (strategy.mode === 'adjacent') {
    return join(dirname(inputPath), `${basename(inputPath, extname(inputPath))}${outputExtension}`);
  }

  if (strategy.mode === 'single-file') {
    if (!strategy.targetPath) {
      throw new Error('Single file output path is missing');
    }
    return strategy.targetPath;
  }

  if (!strategy.targetPath) {
    throw new Error('Output directory path is missing');
  }

  if (basePath) {
    const relPath = relative(basePath, inputPath);
    const relWithoutExtension = join(dirname(relPath), basename(relPath, extname(relPath)));
    return join(strategy.targetPath, `${relWithoutExtension}${outputExtension}`);
  }

  return join(strategy.targetPath, `${basename(inputPath, extname(inputPath))}${outputExtension}`);
};

const buildRelativeBaseHref = (outputPath: string, sourcePath: string): string => {
  let relativePath = relative(dirname(outputPath), sourcePath).split('\\').join('/');
  if (!relativePath) {
    relativePath = '.';
  } else if (!relativePath.startsWith('.') && !relativePath.startsWith('/')) {
    relativePath = `./${relativePath}`;
  }
  return relativePath.endsWith('/') ? relativePath : `${relativePath}/`;
};

const resolveOutputPathForInput = (
  inputPath: string,
  strategy: OutputStrategy,
  inputs: InputDescriptor[]
): string => toOutputPath(inputPath, strategy, findBasePathForFile(inputPath, inputs));

const getOutputCollisionKey = (outputPath: string): string => {
  return isCaseInsensitiveFs ? outputPath.toLowerCase() : outputPath;
};

const buildOutputOwners = (
  files: string[],
  strategy: OutputStrategy,
  inputs: InputDescriptor[]
): Map<string, string> => {
  const owners = new Map<string, string>();

  for (const inputPath of files) {
    const outputPath = resolveOutputPathForInput(inputPath, strategy, inputs);
    const key = getOutputCollisionKey(outputPath);
    const existing = owners.get(key);
    if (existing && existing !== inputPath) {
      throw new Error(
        `Output path collision: ${relative(process.cwd(), existing)} and ${relative(
          process.cwd(),
          inputPath
        )} both resolve to ${relative(process.cwd(), outputPath)}.`
      );
    }
    owners.set(key, inputPath);
  }

  return owners;
};

const readTemplate = async (pathValue?: string): Promise<string | null> => {
  if (!pathValue) return null;
  try {
    return await readFile(resolve(pathValue), 'utf-8');
  } catch (error: unknown) {
    const message = toErrorMessage(error);
    throw new Error(`Failed to read template file "${pathValue}": ${message}`, { cause: error });
  }
};

const createRendererOptions = async (options: RuntimeCliOptions): Promise<RendererOptions> => {
  const isPdfOutput = options.outputFormat !== 'html';
  return {
    customCss: options.css ? resolve(options.css) : null,
    template: options.template ? resolve(options.template) : null,
    margin: options.margin,
    format: options.format,
    toc: options.toc,
    tocDepth: options.tocDepth,
    headerTemplate: isPdfOutput ? await readTemplate(options.header) : null,
    footerTemplate: isPdfOutput ? await readTemplate(options.footer) : null,
    executablePath: options.executablePath,
    maxConcurrentPages: options.maxConcurrentPages,
    linkTargetFormat: options.outputFormat,
    assetMode: options.assetMode,
    assetCacheDir: options.assetCacheDir,
    allowNetworkFallback: options.allowNetworkFallback
  };
};

const runConvertCli = async (): Promise<void> => {
  const program = new Command();

  program
    .name('convpdf')
    .description(
      'Convert Markdown to high-quality PDF or HTML.\n\nSubcommands:\n  convpdf assets <install|verify|update|clean>   Manage offline runtime assets'
    )
    .version(pkg.version)
    .argument('<inputs...>', 'Input markdown files or glob patterns')
    .option('-o, --output <path>', 'Output directory or file path')
    .option('-w, --watch', 'Watch for changes')
    .option('-c, --css <path>', 'Custom CSS')
    .option('-t, --template <path>', 'Custom HTML template')
    .option('-m, --margin <margin>', 'Page margin (default: 15mm 10mm)')
    .option('-f, --format <format>', 'PDF format (default: A4)')
    .option('--header <path>', 'Custom header template')
    .option('--footer <path>', 'Custom footer template')
    .option('--toc', 'Generate Table of Contents')
    .option('--toc-depth <depth>', 'Table of Contents depth', parseInteger)
    .option('--executable-path <path>', 'Puppeteer browser executable path')
    .option('--max-pages <number>', 'Maximum number of concurrent browser pages', parseInteger)
    .option('--preserve-timestamp', 'Preserve modification time from markdown file')
    .option('--output-format <format>', 'Output format: pdf or html', normalizeOutputFormat)
    .option('--html', 'Shortcut for --output-format html')
    .option('--asset-mode <mode>', 'Runtime asset mode: auto, local, or cdn', normalizeAssetMode)
    .option('--asset-cache-dir <path>', 'Runtime asset cache directory')
    .option('--asset-fallback', 'Allow network fallback when local runtime assets are missing')
    .option('--no-asset-fallback', 'Disable network fallback when local runtime assets are missing')
    .option(
      '-j, --concurrency <number>',
      `Number of concurrent conversions (default: ${DEFAULT_CONCURRENCY}, max: ${MAX_CONCURRENCY})`,
      parseInteger
    )
    .action(async (inputs: string[], cliOptions: CliOptions) => {
      let watcher: FSWatcher | null = null;
      let renderer: Renderer | null = null;
      let progressBar: cliProgress.SingleBar | null = null;

      const cleanup = async (): Promise<void> => {
        if (progressBar) {
          progressBar.stop();
          progressBar = null;
        }
        if (watcher) {
          await watcher.close().catch(ignoreError);
          watcher = null;
        }
        if (renderer) {
          await renderer.close().catch(ignoreError);
          renderer = null;
        }
      };

      let shuttingDown = false;
      const removeSignalHandlers = (): void => {
        process.off('SIGINT', handleSignal);
        process.off('SIGTERM', handleSignal);
      };
      const shutdown = async (code: number, reason?: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        if (reason) {
          console.log(chalk.yellow(reason));
        }
        await cleanup();
        removeSignalHandlers();
        process.exit(code);
      };

      const handleSignal = (signal: NodeJS.Signals): void => {
        void shutdown(0, `\nReceived ${signal}. Gracefully shutting down...`);
      };

      process.on('SIGINT', handleSignal);
      process.on('SIGTERM', handleSignal);

      try {
        const loadedConfig = await loadConfig();
        if (loadedConfig.sourcePath) {
          console.log(
            chalk.gray(`Using config: ${relative(process.cwd(), loadedConfig.sourcePath)}`)
          );
        }

        if (cliOptions.assetCacheDir) {
          cliOptions.assetCacheDir = resolve(cliOptions.assetCacheDir);
        }

        const options = resolveRuntimeOptions(loadedConfig.values, cliOptions);

        const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
        const limit = pLimit(concurrency);

        const describedInputs = await describeInputs(inputs);
        const outputStrategy = resolveOutputStrategy(
          options.output,
          describedInputs,
          options.outputFormat ?? 'pdf'
        );
        const files = await resolveMarkdownFiles(describedInputs);
        if (!files.length && !options.watch) {
          throw new Error('No input markdown files found.');
        }
        if (!files.length && options.watch) {
          console.log(chalk.yellow('No input markdown files found yet. Watching for new files...'));
        }

        const outputOwners = buildOutputOwners(files, outputStrategy, describedInputs);
        const matchesUserInputs = createInputMatcher(describedInputs);
        const firstInput = describedInputs[0];
        const singleInput =
          describedInputs.length === 1 && firstInput && firstInput.kind === 'file'
            ? firstInput.absolute
            : null;

        renderer = new Renderer(await createRendererOptions(options));
        const counts = { success: 0, fail: 0 };

        if (!options.watch && files.length > 0 && process.stdout.isTTY) {
          progressBar = new cliProgress.SingleBar({
            format: `${chalk.blue('Converting')} {bar} {percentage}% | {value}/{total} | {file}`,
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true
          });
          progressBar.start(files.length, 0, { file: '' });
        }

        const convert = async (filePath: string, mode: 'batch' | 'watch'): Promise<void> => {
          const inputPath = resolve(filePath);
          const relInput = relative(process.cwd(), inputPath);

          try {
            const inputStats = await stat(inputPath);
            if (!inputStats.isFile()) return;

            if (outputStrategy.mode === 'single-file' && singleInput && inputPath !== singleInput) {
              if (!progressBar) {
                console.log(
                  chalk.yellow(
                    `Skipping ${relInput}: output is configured as a single ${outputStrategy.outputFormat.toUpperCase()} file for ${relative(
                      process.cwd(),
                      singleInput
                    )}.`
                  )
                );
              }
              return;
            }

            const outputPath = resolveOutputPathForInput(
              inputPath,
              outputStrategy,
              describedInputs
            );
            const relOutput = relative(process.cwd(), outputPath);
            const outputKey = getOutputCollisionKey(outputPath);
            const existingOwner = outputOwners.get(outputKey);

            if (existingOwner && existingOwner !== inputPath) {
              throw new Error(
                `Output path collision: ${relative(process.cwd(), existingOwner)} and ${relInput} both resolve to ${relOutput}.`
              );
            }

            outputOwners.set(outputKey, inputPath);
            await mkdir(dirname(outputPath), { recursive: true });

            if (progressBar) {
              progressBar.update(counts.success + counts.fail, { file: relInput });
            } else {
              console.log(
                chalk.blue(`Converting ${chalk.bold(relInput)} -> ${chalk.bold(relOutput)}...`)
              );
            }

            const markdown = await readFile(inputPath, 'utf-8');
            if (!renderer) {
              throw new Error('Renderer is not initialized.');
            }
            if (outputStrategy.outputFormat === 'html') {
              const html = await renderer.renderHtml(markdown, {
                baseHref: buildRelativeBaseHref(outputPath, dirname(inputPath)),
                linkTargetFormat: 'html'
              });
              await writeFile(outputPath, html, 'utf-8');
            } else {
              await renderer.generatePdf(markdown, outputPath, {
                basePath: dirname(inputPath),
                linkTargetFormat: 'pdf'
              });
            }

            if (options.preserveTimestamp) {
              await utimes(outputPath, inputStats.atime, inputStats.mtime);
            }

            counts.success += 1;
            if (progressBar) {
              progressBar.update(counts.success + counts.fail, { file: basename(outputPath) });
            } else {
              console.log(chalk.green(`Done: ${basename(outputPath)}`));
            }
          } catch (error: unknown) {
            counts.fail += 1;
            const message = toErrorMessage(error);
            if (progressBar) {
              progressBar.update(counts.success + counts.fail, { file: `FAILED: ${relInput}` });
              process.stderr.write('\n');
            }
            console.error(chalk.red(`Failed (${relInput}): ${message}`));
            if (mode === 'watch') {
              throw ensureError(error);
            }
          }
        };

        await Promise.all(files.map((filePath) => limit(() => convert(filePath, 'batch'))));

        if (!options.watch) {
          if (progressBar) {
            progressBar.update(files.length, { file: 'Complete' });
            progressBar.stop();
            progressBar = null;
          }

          if (counts.success) {
            console.log(chalk.green(`\nSuccessfully converted ${counts.success} file(s).`));
          }
          if (counts.fail) {
            throw new Error(`Failed to convert ${counts.fail} file(s).`);
          }

          await cleanup();
          removeSignalHandlers();
          return;
        }

        console.log(chalk.yellow('\nWatching for changes... (Press Ctrl+C to stop)'));
        const queue = new ConversionQueue(limit);
        const watchTargets = describedInputs.map((input) =>
          input.kind === 'pattern' ? getGlobParent(input.raw) : input.absolute
        );
        watcher = chokidar.watch(watchTargets, {
          ignored: /(^|[\/\\])\../,
          persistent: true,
          ignoreInitial: true
        });

        watcher.on('all', (event: string, changedPath: string) => {
          if (!/\.(md|markdown)$/i.test(changedPath)) {
            return;
          }

          const absoluteChangedPath = resolve(changedPath);
          if (!matchesUserInputs(absoluteChangedPath)) {
            return;
          }

          if (event === 'unlink') {
            try {
              const outputPath = resolveOutputPathForInput(
                absoluteChangedPath,
                outputStrategy,
                describedInputs
              );
              const outputKey = getOutputCollisionKey(outputPath);
              if (outputOwners.get(outputKey) === absoluteChangedPath) {
                outputOwners.delete(outputKey);
              }
            } catch {
              // Ignore unlink cleanup failures.
            }
            return;
          }

          if (!['add', 'change'].includes(event)) {
            return;
          }

          console.log(
            chalk.cyan(
              `\n${event === 'add' ? 'New file' : 'Change'} detected: ${relative(
                process.cwd(),
                absoluteChangedPath
              )}`
            )
          );
          queue.enqueue(absoluteChangedPath, (filePath) => convert(filePath, 'watch'));
        });

        // Keep the command alive in watch mode even when chokidar has no active fs handles yet.
        await new Promise<void>(() => {});
      } catch (error: unknown) {
        const message = toErrorMessage(error);
        console.error(chalk.red('Error:'), message);
        await cleanup();
        removeSignalHandlers();
        process.exit(1);
      }
    });

  await program.parseAsync();
};

if (process.argv[2] === 'assets') {
  try {
    await runAssetsCommand(process.argv.slice(3));
  } catch (error: unknown) {
    const message = toErrorMessage(error);
    console.error(chalk.red('Error:'), message);
    process.exit(1);
  }
} else {
  await runConvertCli();
}
