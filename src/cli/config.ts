import { readFile, stat } from 'fs/promises';
import { dirname, join, relative, resolve } from 'path';
import yaml from 'js-yaml';
import type { OutputFormat } from '../types.js';
import { normalizeMaxConcurrentPages, normalizeTocDepth } from '../utils/validation.js';
import { isErrnoException, toErrorMessage } from '../utils/errors.js';
import { normalizeAssetMode } from './assets.js';
import type { CliOptions, ConfigFile, LoadedConfig, RuntimeCliOptions } from './types.js';

export const DEFAULT_CONCURRENCY = 5;
export const MAX_CONCURRENCY = 32;

const CONFIG_FILE_CANDIDATES = [
  '.convpdfrc',
  '.convpdfrc.json',
  '.convpdfrc.yaml',
  '.convpdfrc.yml'
];

export const findPackageJson = async (dir: string): Promise<string> => {
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

export const normalizeOutputFormat = (format: unknown): OutputFormat => {
  if (typeof format !== 'string') {
    throw new Error(`Invalid output format "${String(format)}". Expected "pdf" or "html".`);
  }
  const normalized = format.trim().toLowerCase();
  if (normalized === 'pdf' || normalized === 'html') {
    return normalized;
  }
  throw new Error(`Invalid output format "${format}". Expected "pdf" or "html".`);
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

const normalizeConfigPaths = (config: ConfigFile, configPath: string): ConfigFile => {
  const configDir = dirname(configPath);
  const normalized = { ...config };
  if (normalized.css) normalized.css = resolve(configDir, normalized.css);
  if (normalized.template) normalized.template = resolve(configDir, normalized.template);
  if (normalized.header) normalized.header = resolve(configDir, normalized.header);
  if (normalized.footer) normalized.footer = resolve(configDir, normalized.footer);
  if (normalized.output) normalized.output = resolve(configDir, normalized.output);
  if (normalized.assetCacheDir) {
    normalized.assetCacheDir = resolve(configDir, normalized.assetCacheDir);
  }
  return normalized;
};

export const loadConfig = async (): Promise<LoadedConfig> => {
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
        { cause: error }
      );
    }
  }

  return { values: {}, sourcePath: null };
};

export const resolveRuntimeOptions = (
  config: ConfigFile,
  cliOptions: CliOptions
): RuntimeCliOptions => {
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
