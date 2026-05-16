import { access, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
  resolveBuildId
} from '@puppeteer/browsers';
import { PUPPETEER_REVISIONS } from 'puppeteer-core/internal/revisions.js';

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

  if ((await exists(installationDir)) && !(await exists(executablePath))) {
    await rm(installationDir, { recursive: true, force: true });
  }

  await install({
    browser: Browser.CHROME,
    cacheDir,
    platform,
    buildId,
    downloadProgressCallback: 'default'
  });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
