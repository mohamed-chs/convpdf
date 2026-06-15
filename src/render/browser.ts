import { access, mkdir, stat, rm } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
import {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  getInstalledBrowsers,
  install,
  resolveBuildId
} from '@puppeteer/browsers';
import { PUPPETEER_REVISIONS } from 'puppeteer-core/internal/revisions.js';
import { ignoreError, isErrnoException, toErrorMessage } from '../utils/errors.js';

export interface BrowserSetupOptions {
  executablePath?: string;
  onSetupMessage?: (message: string) => void;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const INSTALL_LOCK_NAME = '.chrome-install.lock';
const INSTALL_LOCK_WAIT_MS = 10 * 60 * 1000;
const INSTALL_LOCK_STALE_MS = 20 * 60 * 1000;
const LOCK_POLL_INTERVAL_MS = 250;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

const canAccessPath = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const compareBrowserCacheVersions = (left: string, right: string): number => {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

const resolvePackageRoot = async (): Promise<string | null> => {
  let current = moduleDirectory;
  while (true) {
    if (await canAccessPath(join(current, 'package.json'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
};

const getPackageChromeCacheDir = async (): Promise<string> => {
  const packageRoot = await resolvePackageRoot();
  if (!packageRoot) {
    throw new Error('Unable to locate convpdf package root for Chrome cache.');
  }
  return join(packageRoot, '.puppeteer-cache');
};

const acquireInstallLock = async (cacheDir: string): Promise<() => Promise<void>> => {
  await mkdir(cacheDir, { recursive: true });
  const lockPath = join(cacheDir, INSTALL_LOCK_NAME);
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rm(lockPath, { recursive: true, force: true }).catch(ignoreError);
      };
    } catch (error: unknown) {
      const code = isErrnoException(error) ? error.code : undefined;
      if (code !== 'EEXIST') {
        const message = toErrorMessage(error);
        throw new Error(`Failed to acquire Chrome install lock: ${message}`, { cause: error });
      }

      try {
        const lockStats = await stat(lockPath);
        if (Date.now() - lockStats.mtimeMs > INSTALL_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true }).catch(ignoreError);
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() - startedAt > INSTALL_LOCK_WAIT_MS) {
        throw new Error(
          `Timed out waiting for Chrome install lock in "${cacheDir}" after ${INSTALL_LOCK_WAIT_MS}ms.`
        );
      }
      await sleep(LOCK_POLL_INTERVAL_MS);
    }
  }
};

interface CachedChromeExecutable {
  buildId: string;
  executablePath: string;
}

const listInstalledChromeExecutables = async (
  cacheDir: string
): Promise<CachedChromeExecutable[]> => {
  const installedBrowsers = await getInstalledBrowsers({ cacheDir }).catch(() => []);
  return installedBrowsers
    .filter((browser) => browser.browser === Browser.CHROME)
    .map((browser) => ({
      buildId: browser.buildId,
      executablePath: browser.executablePath
    }));
};

const resolveCachedChromeExecutablePath = async (): Promise<string | undefined> => {
  const packageCacheDir = await getPackageChromeCacheDir().catch(() => undefined);
  const cacheRoots = [
    process.env.PUPPETEER_CACHE_DIR,
    packageCacheDir,
    join(homedir(), '.cache', 'puppeteer')
  ].filter((root): root is string => Boolean(root));
  const candidates = (
    await Promise.all(cacheRoots.map((cacheRoot) => listInstalledChromeExecutables(cacheRoot)))
  )
    .flat()
    .sort((left, right) => compareBrowserCacheVersions(left.buildId, right.buildId))
    .reverse();

  for (const candidate of candidates) {
    if (await canAccessPath(candidate.executablePath)) {
      return candidate.executablePath;
    }
  }

  return undefined;
};

export const resolveChromeExecutablePath = async (): Promise<string | undefined> => {
  const configuredExecutablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configuredExecutablePath) {
    return configuredExecutablePath;
  }

  try {
    const preferredExecutablePath = puppeteer.executablePath();
    if (preferredExecutablePath && (await canAccessPath(preferredExecutablePath))) {
      return preferredExecutablePath;
    }
  } catch {
    // puppeteer-core can throw when no managed browser is configured.
  }

  return resolveCachedChromeExecutablePath();
};

export const ensureChromeExecutablePath = async (
  options: BrowserSetupOptions = {}
): Promise<string | undefined> => {
  if (options.executablePath) {
    return options.executablePath;
  }

  const existingPath = await resolveChromeExecutablePath();
  if (existingPath) {
    return existingPath;
  }

  const platform = detectBrowserPlatform();
  if (!platform) {
    return undefined;
  }

  const cacheDir = await getPackageChromeCacheDir();
  const releaseLock = await acquireInstallLock(cacheDir);
  try {
    const lockedExistingPath = await resolveChromeExecutablePath();
    if (lockedExistingPath) {
      return lockedExistingPath;
    }

    const buildId = await resolveBuildId(Browser.CHROME, platform, PUPPETEER_REVISIONS.chrome);
    const expectedExecutablePath = computeExecutablePath({
      browser: Browser.CHROME,
      cacheDir,
      platform,
      buildId
    });
    options.onSetupMessage?.(`Installing Chrome for PDF rendering in ${cacheDir}`);
    const installedBrowser = await install({
      browser: Browser.CHROME,
      cacheDir,
      platform,
      buildId,
      downloadProgressCallback: 'default'
    });

    const executablePath = installedBrowser.executablePath || expectedExecutablePath;
    if (!(await canAccessPath(executablePath))) {
      throw new Error(`Chrome installation completed without executable: ${executablePath}`);
    }
    return executablePath;
  } finally {
    await releaseLock();
  }
};
