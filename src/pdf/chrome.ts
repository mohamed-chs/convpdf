/**
 * Locate a Chromium-based browser on this machine.
 *
 * mdpdf deliberately does not download a browser: nearly every machine already
 * has Chrome, Chromium, Edge or Brave. Users can point at a specific binary
 * with `--chrome <path>` or the `MDPDF_CHROME` environment variable.
 */
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const LINUX_NAMES = [
  'chrome-headless-shell',
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  'microsoft-edge-stable',
  'microsoft-edge',
  'brave-browser',
  'brave',
  'vivaldi-stable',
];

const MAC_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];

function windowsPaths(): string[] {
  const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(
    (r): r is string => !!r,
  );
  const rel = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Microsoft\\Edge\\Application\\msedge.exe',
    'Chromium\\Application\\chrome.exe',
    'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ];
  return roots.flatMap((root) => rel.map((r) => join(root, r)));
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(name: string): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Browsers installed by `npx @puppeteer/browsers install chrome-headless-shell`. */
function puppeteerCachePaths(): string[] {
  const base = join(homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  if (!existsSync(base)) return [];
  const out: string[] = [];
  try {
    for (const version of readdirSync(base).sort().reverse()) {
      for (const sub of ['chrome-headless-shell-linux64', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64']) {
        out.push(join(base, version, sub, 'chrome-headless-shell'));
      }
      out.push(join(base, version, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    }
  } catch {
    // ignore unreadable cache
  }
  return out;
}

export function findChrome(explicit?: string): string {
  const fromEnv = explicit || process.env['MDPDF_CHROME'] || process.env['CHROME_PATH'] || process.env['PUPPETEER_EXECUTABLE_PATH'];
  if (fromEnv) {
    if (isExecutable(fromEnv)) return fromEnv;
    const resolved = which(fromEnv);
    if (resolved) return resolved;
    throw new Error(`Browser not found or not executable: ${fromEnv}`);
  }
  const candidates: string[] = [...puppeteerCachePaths()];
  if (process.platform === 'darwin') candidates.push(...MAC_PATHS);
  else if (process.platform === 'win32') candidates.push(...windowsPaths());
  for (const path of candidates) if (isExecutable(path)) return path;
  if (process.platform !== 'win32') {
    for (const name of LINUX_NAMES) {
      const found = which(name);
      if (found) return found;
    }
  }
  throw new Error(
    'Could not find Chrome, Chromium, Edge or Brave.\n' +
      '  Install one of them, or point mdpdf at a binary with --chrome <path> or MDPDF_CHROME=<path>.\n' +
      '  A lightweight option: npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer',
  );
}
