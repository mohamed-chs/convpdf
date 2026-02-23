import { stat } from 'fs/promises';
import { dirname, relative, resolve } from 'path';
import { glob } from 'glob';
import { minimatch } from 'minimatch';
import { isErrnoException, toErrorMessage } from '../utils/errors.js';
import type { InputDescriptor } from './types.js';

const isCaseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';
const toPosixPath = (value: string): string => value.split('\\').join('/');

const hasGlobMagic = (value: string): boolean => /[*?[\]{}]/.test(value);

export const getGlobParent = (pattern: string): string => {
  let current = pattern;
  while (current.endsWith('/') || current.endsWith('\\')) {
    current = current.slice(0, -1);
  }
  while (hasGlobMagic(current) && current !== dirname(current)) {
    current = dirname(current);
  }
  return resolve(current);
};

const pathIsWithin = (basePath: string, targetPath: string): boolean => {
  const relPath = relative(basePath, targetPath);
  if (!relPath) return true;
  return !relPath.startsWith('..') && !/^(?:[a-zA-Z]:)?[/\\]/.test(relPath);
};

export const findBasePathForFile = (
  absoluteFilePath: string,
  inputs: InputDescriptor[]
): string => {
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

export const describeInputs = async (inputs: string[]): Promise<InputDescriptor[]> =>
  Promise.all(
    inputs.map(async (raw) => {
      const absolute = resolve(raw);
      try {
        const stats = await stat(absolute);
        if (stats.isFile()) {
          return { raw, absolute, kind: 'file' };
        }
        if (stats.isDirectory()) {
          return { raw, absolute, kind: 'directory' };
        }
        return { raw, absolute, kind: hasGlobMagic(raw) ? 'pattern' : 'file' };
      } catch (error: unknown) {
        if (!isErrnoException(error) || error.code !== 'ENOENT') {
          const message = toErrorMessage(error);
          throw new Error(`Failed to inspect input path "${raw}": ${message}`, { cause: error });
        }
        return { raw, absolute, kind: hasGlobMagic(raw) ? 'pattern' : 'file' };
      }
    })
  );

export const resolveMarkdownFiles = async (inputs: InputDescriptor[]): Promise<string[]> => {
  const matches = await Promise.all(
    inputs.map(async (input) => {
      if (input.kind === 'file') {
        try {
          const stats = await stat(input.absolute);
          if (stats.isFile()) return [input.absolute];
        } catch (error: unknown) {
          if (!isErrnoException(error) || error.code !== 'ENOENT') {
            const message = toErrorMessage(error);
            throw new Error(
              `Failed to read input file "${relative(process.cwd(), input.absolute)}": ${message}`,
              { cause: error }
            );
          }
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
        } catch (error: unknown) {
          if (!isErrnoException(error) || error.code !== 'ENOENT') {
            const message = toErrorMessage(error);
            throw new Error(
              `Failed to read input directory "${relative(process.cwd(), input.absolute)}": ${message}`,
              { cause: error }
            );
          }
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

export const createInputMatcher = (
  inputs: InputDescriptor[]
): ((candidatePath: string) => boolean) => {
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
