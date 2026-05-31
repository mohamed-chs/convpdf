import { execFile } from 'node:child_process';
import { access, chmod, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
  resolveBuildId
} from '@puppeteer/browsers';
import { PUPPETEER_REVISIONS } from 'puppeteer-core/internal/revisions.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(__dirname);
const cacheDir = join(packageRoot, '.puppeteer-cache');

const shouldSkipDownload = () => {
  const raw = process.env.PUPPETEER_SKIP_DOWNLOAD;
  if (raw === undefined) return false;
  switch (raw.toLowerCase()) {
    case '':
    case '0':
    case 'false':
    case 'off':
      return false;
    default:
      return true;
  }
};

const exists = async (pathValue) => {
  try {
    await access(pathValue);
    return true;
  } catch {
    return false;
  }
};

const extractZip = async (archivePath, destinationDir) => {
  await mkdir(destinationDir, { recursive: true });

  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
      archivePath,
      destinationDir
    ]);
    return;
  }

  await execFileAsync('unzip', ['-q', archivePath, '-d', destinationDir]);
};

const main = async () => {
  if (process.env.PUPPETEER_EXECUTABLE_PATH || shouldSkipDownload()) {
    return;
  }

  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error('Unsupported platform for bundled Chrome download.');
  }

  const buildId = await resolveBuildId(Browser.CHROME, platform, PUPPETEER_REVISIONS.chrome);
  const executablePath = computeExecutablePath({
    browser: Browser.CHROME,
    cacheDir,
    platform,
    buildId
  });
  const installationDir = dirname(dirname(executablePath));

  if (await exists(executablePath)) {
    return;
  }

  if (await exists(installationDir)) {
    await rm(installationDir, { recursive: true, force: true });
  }

  const archivePath = await install({
    browser: Browser.CHROME,
    cacheDir,
    platform,
    buildId,
    unpack: false,
    downloadProgressCallback: 'default'
  });

  await extractZip(archivePath, installationDir);
  if (!(await exists(executablePath))) {
    throw new Error(`Chrome installation completed without executable: ${executablePath}`);
  }
  if (process.platform !== 'win32') {
    await chmod(executablePath, 0o755);
  }
  await rm(archivePath, { force: true });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
