import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, mkdtemp, readdir, readFile, rm, rename, stat } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { pipeline } from 'stream/promises';
import { URL } from 'url';
import https from 'https';
import * as tar from 'tar';
import {
  ASSET_ARCHIVES,
  ASSET_SCHEMA_VERSION,
  EXPECTED_RUNTIME_FILES,
  type AssetArchiveSpec
} from './manifest.js';
import { ignoreError, toErrorMessage } from '../utils/errors.js';

export interface RuntimeAssetPaths {
  cacheRoot: string;
  runtimeDir: string;
  mathJaxPath: string;
  mermaidPath: string;
  mathJaxDir: string;
  mathJaxFontDir: string;
}

export interface AssetInstallResult {
  installed: boolean;
  runtimeDir: string;
}

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 30000;
const INSTALL_LOCK_NAME = '.runtime-install.lock';
const INSTALL_LOCK_WAIT_MS = 120000;
const INSTALL_LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_INTERVAL_MS = 250;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

const parseIntegrity = (
  integrity: string
): {
  algorithm: string;
  expected: string;
} => {
  const [algorithm, expected] = integrity.split('-', 2);
  if (!algorithm || !expected) {
    throw new Error(`Invalid integrity value: ${integrity}`);
  }
  return { algorithm, expected };
};

const computeDigestBase64 = async (filePath: string, algorithm: string): Promise<string> => {
  const content = await readFile(filePath);
  return createHash(algorithm).update(content).digest('base64');
};

const withNoThrowCleanup = async (pathValue: string): Promise<void> => {
  await rm(pathValue, { recursive: true, force: true }).catch(ignoreError);
};

const ensureDir = async (dirPath: string): Promise<void> => {
  await mkdir(dirPath, { recursive: true });
};

const hasFile = async (pathValue: string): Promise<boolean> => {
  try {
    const stats = await stat(pathValue);
    return stats.isFile();
  } catch {
    return false;
  }
};

const defaultCacheRoot = (): string => {
  const custom = process.env.CONVPDF_CACHE_DIR;
  if (custom) return resolve(custom);

  if (process.platform === 'win32') {
    const appData = process.env.LOCALAPPDATA ?? process.env.APPDATA;
    if (appData) return join(appData, 'convpdf', 'cache');
  }

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'convpdf');
  }

  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return join(xdg, 'convpdf');

  return join(homedir(), '.cache', 'convpdf');
};

const runtimeDirFor = (cacheRoot: string): string =>
  join(cacheRoot, `runtime-${ASSET_SCHEMA_VERSION}`);

const resolveRuntimePaths = (cacheRootInput?: string): RuntimeAssetPaths => {
  const cacheRoot = resolve(cacheRootInput ?? defaultCacheRoot());
  const runtimeDir = runtimeDirFor(cacheRoot);
  return {
    cacheRoot,
    runtimeDir,
    mathJaxPath: join(runtimeDir, 'mathjax', 'tex-chtml.js'),
    mermaidPath: join(runtimeDir, 'mermaid', 'mermaid.min.js'),
    mathJaxDir: join(runtimeDir, 'mathjax'),
    mathJaxFontDir: join(runtimeDir, 'mathjax-newcm-font')
  };
};

const downloadToFile = async (
  urlValue: string,
  targetPath: string,
  redirectCount = 0
): Promise<void> => {
  const requestUrl = new URL(urlValue);

  await ensureDir(dirname(targetPath));

  await new Promise<void>((resolveDownload, rejectDownload) => {
    let settled = false;
    const resolveOnce = (): void => {
      if (settled) return;
      settled = true;
      resolveDownload();
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      rejectDownload(error);
    };

    const request = https.get(requestUrl, (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        if (redirectCount >= MAX_REDIRECTS) {
          rejectOnce(new Error(`Too many redirects while downloading ${urlValue}`));
          return;
        }
        const redirected = new URL(response.headers.location, requestUrl);
        response.resume();
        void downloadToFile(redirected.toString(), targetPath, redirectCount + 1)
          .then(resolveOnce)
          .catch((error: unknown) => {
            rejectOnce(error instanceof Error ? error : new Error(String(error)));
          });
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        rejectOnce(new Error(`Failed to download ${urlValue}: HTTP ${statusCode}`));
        return;
      }

      response.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        response.destroy(
          new Error(`Timed out downloading ${urlValue} after ${DOWNLOAD_TIMEOUT_MS}ms`)
        );
      });
      const output = createWriteStream(targetPath);
      void pipeline(response, output)
        .then(resolveOnce)
        .catch((error: unknown) => {
          rejectOnce(error instanceof Error ? error : new Error(String(error)));
        });
    });

    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(
        new Error(`Timed out downloading ${urlValue} after ${DOWNLOAD_TIMEOUT_MS}ms`)
      );
    });
    request.on('error', (error: Error) => {
      rejectOnce(error);
    });
  });
};

const acquireInstallLock = async (cacheRoot: string): Promise<() => Promise<void>> => {
  const lockPath = join(cacheRoot, INSTALL_LOCK_NAME);
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockPath);
      return async () => {
        await withNoThrowCleanup(lockPath);
      };
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') {
        const message = toErrorMessage(error);
        throw new Error(`Failed to acquire asset install lock: ${message}`);
      }

      try {
        const lockStats = await stat(lockPath);
        if (Date.now() - lockStats.mtimeMs > INSTALL_LOCK_STALE_MS) {
          await withNoThrowCleanup(lockPath);
          continue;
        }
      } catch {
        // Lock disappeared while checking; retry immediately.
        continue;
      }

      if (Date.now() - startedAt > INSTALL_LOCK_WAIT_MS) {
        throw new Error(
          `Timed out waiting for asset install lock in "${cacheRoot}" after ${INSTALL_LOCK_WAIT_MS}ms.`
        );
      }
      await sleep(LOCK_POLL_INTERVAL_MS);
    }
  }
};

const assertIntegrity = async (archivePath: string, spec: AssetArchiveSpec): Promise<void> => {
  const { algorithm, expected } = parseIntegrity(spec.integrity);
  const actual = await computeDigestBase64(archivePath, algorithm);
  if (actual !== expected) {
    throw new Error(`Integrity check failed for ${spec.id}`);
  }
};

const extractArchive = async (
  archivePath: string,
  spec: AssetArchiveSpec,
  destinationRoot: string
): Promise<void> => {
  if (spec.id === 'mathjax') {
    const target = join(destinationRoot, 'mathjax');
    await ensureDir(target);
    await tar.x({ file: archivePath, cwd: target, strip: 1 });
    return;
  }

  if (spec.id === 'mathjax-font') {
    const target = join(destinationRoot, 'mathjax-newcm-font');
    await ensureDir(target);
    await tar.x({ file: archivePath, cwd: target, strip: 1 });
    return;
  }

  const target = join(destinationRoot, 'mermaid');
  await ensureDir(target);
  await tar.x({
    file: archivePath,
    cwd: target,
    strip: 2,
    filter: (entryPath: string) => entryPath === 'package/dist/mermaid.min.js'
  });
};

const assertRuntimeFiles = async (runtimeDir: string): Promise<void> => {
  for (const filePath of EXPECTED_RUNTIME_FILES) {
    const absolute = join(runtimeDir, filePath);
    if (!(await hasFile(absolute))) {
      throw new Error(`Missing runtime asset file: ${absolute}`);
    }
  }

  const fontDir = join(runtimeDir, 'mathjax-newcm-font', 'chtml', 'woff2');
  const entries = await readdir(fontDir).catch(() => []);
  if (!entries.some((entry) => entry.endsWith('.woff2'))) {
    throw new Error(`Missing runtime font files in: ${fontDir}`);
  }
};

export const getRuntimeAssetPaths = (cacheDir?: string): RuntimeAssetPaths =>
  resolveRuntimePaths(cacheDir);

export const isRuntimeInstalled = async (cacheDir?: string): Promise<boolean> => {
  const paths = resolveRuntimePaths(cacheDir);
  try {
    await assertRuntimeFiles(paths.runtimeDir);
    return true;
  } catch {
    return false;
  }
};

export const verifyRuntimeAssets = async (cacheDir?: string): Promise<RuntimeAssetPaths> => {
  const paths = resolveRuntimePaths(cacheDir);
  await assertRuntimeFiles(paths.runtimeDir);
  return paths;
};

export const installRuntimeAssets = async (
  cacheDir?: string,
  force = false
): Promise<AssetInstallResult> => {
  const paths = resolveRuntimePaths(cacheDir);
  await ensureDir(paths.cacheRoot);
  const releaseLock = await acquireInstallLock(paths.cacheRoot);
  try {
    if (!force && (await isRuntimeInstalled(cacheDir))) {
      return { installed: false, runtimeDir: paths.runtimeDir };
    }

    const tempRoot = await mkdtemp(join(paths.cacheRoot, '.convpdf-assets-'));
    const tempRuntimeDir = join(tempRoot, `runtime-${ASSET_SCHEMA_VERSION}`);
    const downloadsDir = join(tempRoot, 'downloads');

    try {
      await ensureDir(tempRuntimeDir);
      await ensureDir(downloadsDir);

      for (const spec of ASSET_ARCHIVES) {
        const archivePath = join(downloadsDir, `${spec.id}.tgz`);
        await downloadToFile(spec.tarballUrl, archivePath);
        await assertIntegrity(archivePath, spec);
        await extractArchive(archivePath, spec, tempRuntimeDir);
      }

      await assertRuntimeFiles(tempRuntimeDir);

      const stagedTarget = `${paths.runtimeDir}.staging-${process.pid}-${Date.now()}`;
      await withNoThrowCleanup(stagedTarget);
      await rename(tempRuntimeDir, stagedTarget);
      await withNoThrowCleanup(paths.runtimeDir);
      await rename(stagedTarget, paths.runtimeDir);

      return { installed: true, runtimeDir: paths.runtimeDir };
    } finally {
      await withNoThrowCleanup(tempRoot);
    }
  } finally {
    await releaseLock();
  }
};

export const cleanRuntimeAssets = async (cacheDir?: string): Promise<void> => {
  const { runtimeDir, cacheRoot } = resolveRuntimePaths(cacheDir);
  await ensureDir(cacheRoot);
  const releaseLock = await acquireInstallLock(cacheRoot);
  try {
    await withNoThrowCleanup(runtimeDir);
  } finally {
    await releaseLock();
  }
};

export const resolveAssetCacheDir = (cacheDir?: string): string =>
  resolveRuntimePaths(cacheDir).cacheRoot;
