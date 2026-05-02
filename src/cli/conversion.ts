import { mkdir, readFile, stat, utimes, writeFile } from 'fs/promises';
import { basename, dirname, relative, resolve } from 'path';
import chalk from 'chalk';
import type pLimit from 'p-limit';
import { Renderer } from '../renderer.js';
import { ensureError, toErrorMessage } from '../utils/errors.js';
import { createInputMatcher, getGlobParent } from './inputs.js';
import {
  buildOutputOwners,
  buildRelativeBaseHref,
  getOutputCollisionKey,
  resolveOutputPathForInput
} from './output.js';
import type { InputDescriptor, OutputStrategy, RuntimeCliOptions } from './types.js';

const MAX_WATCH_RETRIES = 5;
const WATCH_RETRY_BASE_MS = 200;

export interface ConversionProgress {
  update: (value: number, payload: { file: string }) => void;
}

export interface ConversionCounts {
  success: number;
  fail: number;
}

export class ConversionQueue {
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
              await new Promise<void>((resolveDelay) => {
                setTimeout(resolveDelay, backoffMs);
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

export class ConversionSession {
  private readonly outputOwners: Map<string, string>;
  private readonly matchesUserInputs: (candidatePath: string) => boolean;
  private readonly singleInput: string | null;
  private readonly counts: ConversionCounts = { success: 0, fail: 0 };

  constructor(
    private readonly input: {
      renderer: Renderer;
      options: RuntimeCliOptions;
      describedInputs: InputDescriptor[];
      outputStrategy: OutputStrategy;
      files: string[];
      progressBar: ConversionProgress | null;
    }
  ) {
    this.outputOwners = buildOutputOwners(
      input.files,
      input.outputStrategy,
      input.describedInputs
    );
    this.matchesUserInputs = createInputMatcher(input.describedInputs);
    const firstInput = input.describedInputs[0];
    this.singleInput =
      input.describedInputs.length === 1 && firstInput && firstInput.kind === 'file'
        ? firstInput.absolute
        : null;
  }

  getCounts(): ConversionCounts {
    return { ...this.counts };
  }

  getWatchTargets(): string[] {
    return this.input.describedInputs.map((input) =>
      input.kind === 'pattern' ? getGlobParent(input.raw) : input.absolute
    );
  }

  async runBatch(limit: ReturnType<typeof pLimit>): Promise<void> {
    await Promise.all(this.input.files.map((filePath) => limit(() => this.convert(filePath, 'batch'))));
  }

  handleWatchEvent(event: string, changedPath: string, queue: ConversionQueue): void {
    if (!/\.(md|markdown)$/i.test(changedPath)) {
      return;
    }

    const absoluteChangedPath = resolve(changedPath);
    if (!this.matchesUserInputs(absoluteChangedPath)) {
      return;
    }

    if (event === 'unlink') {
      this.releaseOutputOwner(absoluteChangedPath);
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
    queue.enqueue(absoluteChangedPath, (filePath) => this.convert(filePath, 'watch'));
  }

  private releaseOutputOwner(inputPath: string): void {
    try {
      const outputPath = resolveOutputPathForInput(
        inputPath,
        this.input.outputStrategy,
        this.input.describedInputs
      );
      const outputKey = getOutputCollisionKey(outputPath);
      if (this.outputOwners.get(outputKey) === inputPath) {
        this.outputOwners.delete(outputKey);
      }
    } catch {
      // Ignore unlink cleanup failures.
    }
  }

  private async convert(filePath: string, mode: 'batch' | 'watch'): Promise<void> {
    const inputPath = resolve(filePath);
    const relInput = relative(process.cwd(), inputPath);

    try {
      const inputStats = await stat(inputPath);
      if (!inputStats.isFile()) return;

      if (
        this.input.outputStrategy.mode === 'single-file' &&
        this.singleInput &&
        inputPath !== this.singleInput
      ) {
        if (!this.input.progressBar) {
          console.log(
            chalk.yellow(
              `Skipping ${relInput}: output is configured as a single ${this.input.outputStrategy.outputFormat.toUpperCase()} file for ${relative(
                process.cwd(),
                this.singleInput
              )}.`
            )
          );
        }
        return;
      }

      const outputPath = resolveOutputPathForInput(
        inputPath,
        this.input.outputStrategy,
        this.input.describedInputs
      );
      const relOutput = relative(process.cwd(), outputPath);
      const outputKey = getOutputCollisionKey(outputPath);
      const existingOwner = this.outputOwners.get(outputKey);

      if (existingOwner && existingOwner !== inputPath) {
        throw new Error(
          `Output path collision: ${relative(process.cwd(), existingOwner)} and ${relInput} both resolve to ${relOutput}.`
        );
      }

      this.outputOwners.set(outputKey, inputPath);
      await mkdir(dirname(outputPath), { recursive: true });

      if (this.input.progressBar) {
        this.input.progressBar.update(this.counts.success + this.counts.fail, { file: relInput });
      } else {
        console.log(chalk.blue(`Converting ${chalk.bold(relInput)} -> ${chalk.bold(relOutput)}...`));
      }

      const markdown = await readFile(inputPath, 'utf-8');
      if (this.input.outputStrategy.outputFormat === 'html') {
        const html = await this.input.renderer.renderHtml(markdown, {
          baseHref: buildRelativeBaseHref(outputPath, dirname(inputPath)),
          linkTargetFormat: 'html'
        });
        await writeFile(outputPath, html, 'utf-8');
      } else {
        await this.input.renderer.generatePdf(markdown, outputPath, {
          basePath: dirname(inputPath),
          linkTargetFormat: 'pdf'
        });
      }

      if (this.input.options.preserveTimestamp) {
        await utimes(outputPath, inputStats.atime, inputStats.mtime);
      }

      this.counts.success += 1;
      if (this.input.progressBar) {
        this.input.progressBar.update(this.counts.success + this.counts.fail, {
          file: basename(outputPath)
        });
      } else {
        console.log(chalk.green(`Done: ${basename(outputPath)}`));
      }
    } catch (error: unknown) {
      this.counts.fail += 1;
      const message = toErrorMessage(error);
      if (this.input.progressBar) {
        this.input.progressBar.update(this.counts.success + this.counts.fail, {
          file: `FAILED: ${relInput}`
        });
        process.stderr.write('\n');
      }
      console.error(chalk.red(`Failed (${relInput}): ${message}`));
      if (mode === 'watch') {
        throw ensureError(error);
      }
    }
  }
}
