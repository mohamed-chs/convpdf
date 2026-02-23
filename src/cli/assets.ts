import { resolve } from 'path';
import chalk from 'chalk';
import {
  cleanRuntimeAssets,
  installRuntimeAssets,
  resolveAssetCacheDir,
  verifyRuntimeAssets
} from '../assets/manager.js';
import type { AssetMode } from '../types.js';
import type { AssetsCommandOptions } from './types.js';

export const normalizeAssetMode = (mode: unknown): AssetMode => {
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

export const runAssetsCommand = async (args: string[]): Promise<void> => {
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
