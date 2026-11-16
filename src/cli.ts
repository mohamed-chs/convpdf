#!/usr/bin/env node
/**
 * mdpdf entry point.
 *
 * Starting Chrome is the slowest part of a conversion, so it is launched here,
 * before the rest of the program (markdown-it, plugins, ...) is even loaded;
 * module loading then overlaps with the browser start-up.
 */
import { Browser } from './pdf/browser.ts';

/** Start the browser early when the command line will (very likely) need it. */
function earlyBrowser(argv: string[]): Promise<Browser> | undefined {
  if (argv[0] === 'serve') return undefined;
  if (argv.length === 0 && process.stdin.isTTY) return undefined; // prints help
  let chrome: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') break;
    if (arg === '-h' || arg === '--help' || arg === '-v' || arg === '--version' || arg === '--html') return undefined;
    if (arg === '--chrome') chrome = argv[i + 1];
    else if (arg.startsWith('--chrome=')) chrome = arg.slice('--chrome='.length);
  }
  try {
    return Browser.launch({ executablePath: chrome });
  } catch {
    return undefined; // e.g. Chrome not found: reported later, in context
  }
}

const argv = process.argv.slice(2);
const browser = earlyBrowser(argv);
let instance = null as Browser | null;
browser?.then((b) => (instance = b)).catch(() => {});
// Never leave the browser running, whatever path the program exits through.
process.once('exit', () => instance?.killSync());

const { main } = await import('./run.ts');
process.exitCode = await main(argv, browser);
// Normally the converter has closed it; after an early error (bad option,
// missing file) the browser may still be starting.
if (browser) (await browser.catch(() => null))?.killSync();
