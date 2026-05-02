#!/usr/bin/env node
import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import chokidar, { type FSWatcher } from 'chokidar';
import cliProgress from 'cli-progress';
import pLimit from 'p-limit';
import { Renderer } from '../src/renderer.js';
import type { RendererOptions } from '../src/types.js';
import { ignoreError, toErrorMessage } from '../src/utils/errors.js';
import { runAssetsCommand, normalizeAssetMode } from '../src/cli/assets.js';
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  findPackageJson,
  loadConfig,
  normalizeOutputFormat,
  resolveRuntimeOptions
} from '../src/cli/config.js';
import { describeInputs, resolveMarkdownFiles } from '../src/cli/inputs.js';
import { resolveOutputStrategy } from '../src/cli/output.js';
import { ConversionQueue, ConversionSession } from '../src/cli/conversion.js';
import type { CliOptions, RuntimeCliOptions } from '../src/cli/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(await readFile(await findPackageJson(__dirname), 'utf-8')) as {
  version: string;
};

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

        renderer = new Renderer(await createRendererOptions(options));

        if (!options.watch && files.length > 0 && process.stdout.isTTY) {
          progressBar = new cliProgress.SingleBar({
            format: `${chalk.blue('Converting')} {bar} {percentage}% | {value}/{total} | {file}`,
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true
          });
          progressBar.start(files.length, 0, { file: '' });
        }

        const session = new ConversionSession({
          renderer,
          options,
          describedInputs,
          outputStrategy,
          files,
          progressBar
        });

        await session.runBatch(limit);

        if (!options.watch) {
          if (progressBar) {
            progressBar.update(files.length, { file: 'Complete' });
            progressBar.stop();
            progressBar = null;
          }

          const counts = session.getCounts();
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
        watcher = chokidar.watch(session.getWatchTargets(), {
          ignored: /(^|[\/\\])\../,
          persistent: true,
          ignoreInitial: true
        });

        watcher.on('all', (event: string, changedPath: string) => {
          session.handleWatchEvent(event, changedPath, queue);
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
