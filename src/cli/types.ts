import type { AssetMode, OutputFormat, RendererOptions } from '../types.js';

export interface CliOptions {
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

export interface ConfigFile extends RendererOptions {
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

export interface LoadedConfig {
  values: ConfigFile;
  sourcePath: string | null;
}

export type OutputMode = 'adjacent' | 'directory' | 'single-file';

export interface OutputStrategy {
  mode: OutputMode;
  targetPath: string | null;
  outputFormat: OutputFormat;
}

export interface InputDescriptor {
  raw: string;
  absolute: string;
  kind: 'file' | 'directory' | 'pattern';
}

export interface RuntimeCliOptions extends ConfigFile {
  html?: boolean;
  maxPages?: number;
}

export interface AssetsCommandOptions {
  cacheDir?: string;
  force?: boolean;
  json?: boolean;
}
