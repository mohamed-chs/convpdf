#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, readFile, stat, utimes, writeFile } from 'fs/promises';
import { basename, dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import chokidar, { type FSWatcher } from 'chokidar';
import cliProgress from 'cli-progress';
import pLimit from 'p-limit';
import { Renderer } from '../src/renderer.js';
import type { RendererOptions } from '../src/types.js';
import { ensureError, ignoreError, toErrorMessage } from '../src/utils/errors.js';
import { runAssetsCommand, normalizeAssetMode } from '../src/cli/assets.js';
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  findPackageJson,
  loadConfig,
  normalizeOutputFormat,
  resolveRuntimeOptions
} from '../src/cli/config.js';
import {
  createInputMatcher,
  describeInputs,
  getGlobParent,
  resolveMarkdownFiles
} from '../src/cli/inputs.js';
import {
  buildOutputOwners,
  buildRelativeBaseHref,
  getOutputCollisionKey,
  resolveOutputPathForInput,
  resolveOutputStrategy
} from '../src/cli/output.js';
import type { CliOptions, RuntimeCliOptions } from '../src/cli/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(await readFile(await findPackageJson(__dirname), 'utf-8')) as {
  version: string;
};

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

const parseInteger = (raw: string): number => {
  const normalized = raw.trim();
  if (!/^[+-]?\d+$/.test(normalized)) {
    throw new Error(`Invalid integer "${raw}"`);
  }
  return Number.parseInt(normalized, 10);
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
