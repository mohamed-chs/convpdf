import { basename, dirname, extname, join, relative, resolve } from 'path';
import type { OutputFormat } from '../types.js';
import { findBasePathForFile } from './inputs.js';
import type { InputDescriptor, OutputStrategy } from './types.js';

const isCaseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';

export const resolveOutputStrategy = (
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

export const resolveOutputPathForInput = (
  inputPath: string,
  strategy: OutputStrategy,
  inputs: InputDescriptor[]
): string => toOutputPath(inputPath, strategy, findBasePathForFile(inputPath, inputs));

export const getOutputCollisionKey = (outputPath: string): string => {
  return isCaseInsensitiveFs ? outputPath.toLowerCase() : outputPath;
};

export const buildOutputOwners = (
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

export const buildRelativeBaseHref = (outputPath: string, sourcePath: string): string => {
  let relativePath = relative(dirname(outputPath), sourcePath).split('\\').join('/');
  if (!relativePath) {
    relativePath = '.';
  } else if (!relativePath.startsWith('.') && !relativePath.startsWith('/')) {
    relativePath = `./${relativePath}`;
  }
  return relativePath.endsWith('/') ? relativePath : `${relativePath}/`;
};
