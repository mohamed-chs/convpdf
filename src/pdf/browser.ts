/**
 * A tiny headless-Chrome driver: launch, open pages, load a document, print.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { CdpConnection } from './cdp.ts';
import { trace } from '../debug.ts';
import { findChrome } from './chrome.ts';

export interface LaunchOptions {
  executablePath?: string;
  /** Extra command line flags. */
  args?: string[];
}

const DEFAULT_ARGS = [
  '--headless',
  '--remote-debugging-pipe',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-dev-shm-usage',
  '--disable-features=Translate,MediaRouter,OptimizationHints,AcceptCHFrame,DialMediaRouteProvider,PaintHolding',
  '--metrics-recording-only',
  '--password-store=basic',
  '--use-mock-keychain',
  '--mute-audio',
  '--hide-scrollbars',
  '--font-render-hinting=none',
  // Let our generated file:// document load fonts, stylesheets and images
  // from other file:// locations (node_modules, the markdown's folder).
  '--allow-file-access-from-files',
];

export class Browser {
  #proc: ChildProcess;
  #conn: CdpConnection;
  #profileDir: string;
  #closed = false;
  #firstTarget: Promise<{ targetId?: string }> | null = null;
  readonly executablePath: string;

  private constructor(proc: ChildProcess, conn: CdpConnection, profileDir: string, executablePath: string) {
    this.#proc = proc;
    this.#conn = conn;
    this.#profileDir = profileDir;
    this.executablePath = executablePath;
  }

  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    const executablePath = findChrome(options.executablePath);
    const profileDir = mkdtempSync(join(tmpdir(), 'mdpdf-chrome-'));
    const args = [...DEFAULT_ARGS, `--user-data-dir=${profileDir}`, ...(options.args ?? [])];
    // Chrome refuses to start as root unless the sandbox is disabled.
    if (process.getuid?.() === 0) args.push('--no-sandbox');
    args.push('about:blank');

    const proc = spawn(executablePath, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      detached: false,
    });
    let stderr = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (d: string) => {
      if (stderr.length < 8000) stderr += d;
    });
    const conn = new CdpConnection(proc.stdio[4] as Readable, proc.stdio[3] as Writable);
    const browser = new Browser(proc, conn, profileDir, executablePath);

    const exited = new Promise<never>((_, reject) => {
      proc.once('error', (err) => reject(new Error(`Failed to start browser (${executablePath}): ${err.message}`)));
      proc.once('exit', (code, signal) => {
        conn.dispose(new Error(`Browser exited unexpectedly (code ${code ?? signal})`));
        reject(new Error(`Browser exited during startup (code ${code ?? signal}).\n${stderr.trim()}`));
      });
    });
    exited.catch(() => {});
    try {
      const t = trace(`browser: launching ${executablePath}`);
      // Queue the first page's creation right away; Chrome handles it as soon
      // as it is up, saving a round trip after start-up.
      browser.#firstTarget = conn.send('Target.createTarget', { url: 'about:blank' });
      browser.#firstTarget.catch(() => {});
      await Promise.race([conn.send('Browser.getVersion'), exited]);
      trace('browser: ready', t);
    } catch (err) {
      browser.#cleanup();
      throw err;
    }
    return browser;
  }

  async newPage(): Promise<Page> {
    const first = this.#firstTarget;
    this.#firstTarget = null;
    const { targetId } = await (first ?? this.#conn.send('Target.createTarget', { url: 'about:blank' }));
    const { sessionId } = await this.#conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.#conn, sessionId, targetId);
    await page.init();
    return page;
  }

  get connected(): boolean {
    return !this.#closed && !this.#conn.closed;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await Promise.race([this.#conn.send('Browser.close'), new Promise((r) => setTimeout(r, 1500).unref())]);
    } catch {
      // already gone
    }
    this.#cleanup();
  }

  #cleanup(): void {
    this.#closed = true;
    if (this.#proc.exitCode === null && this.#proc.signalCode === null) this.#proc.kill('SIGKILL');
    this.#conn.dispose(new Error('Browser closed'));
    try {
      rmSync(this.#profileDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // best effort
    }
  }

  /** Synchronous last-resort cleanup for process exit handlers. */
  killSync(): void {
    this.#cleanup();
  }
}

export interface PrintOptions {
  /** Generate a PDF outline (bookmarks) from the document headings. */
  outline?: boolean;
  /** Generate a tagged (accessible) PDF. */
  tagged?: boolean;
}

export class Page {
  #conn: CdpConnection;
  readonly sessionId: string;
  readonly targetId: string;

  constructor(conn: CdpConnection, sessionId: string, targetId: string) {
    this.#conn = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  async init(): Promise<void> {
    await this.#send('Page.enable');
  }

  #send(method: string, params: Record<string, unknown> = {}) {
    return this.#conn.send(method, params, this.sessionId);
  }

  /** Send a raw DevTools protocol command to this page. */
  command(method: string, params: Record<string, unknown> = {}) {
    return this.#send(method, params);
  }

  /**
   * Navigate to `url`, wait for the load event and then for the document's
   * own readiness promise (`window.__mdpdfReady`, which waits for fonts,
   * images, and diagram rendering).
   */
  async load(url: string, timeoutMs: number): Promise<string[]> {
    const loaded = this.#conn.waitFor('Page.loadEventFired', this.sessionId, timeoutMs);
    loaded.catch(() => {});
    const nav = await this.#send('Page.navigate', { url });
    if (nav.errorText) throw new Error(`Failed to load document: ${nav.errorText}`);
    await loaded;
    const result = await this.evaluate<string[] | null>(
      `window.__mdpdfReady ? window.__mdpdfReady : null`,
      timeoutMs,
    );
    return result ?? [];
  }

  async evaluate<T = unknown>(expression: string, timeoutMs = 30_000): Promise<T> {
    const call = this.#send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for the document to render`)), timeoutMs);
    });
    try {
      const res = await Promise.race([call, timeout]);
      if (res.exceptionDetails) {
        const desc = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
        throw new Error(`Page script error: ${desc}`);
      }
      return res.result?.value as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Print the loaded document. Page size and margins come from CSS `@page`. */
  async pdf(options: PrintOptions = {}): Promise<Buffer> {
    const { stream } = await this.#send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      generateDocumentOutline: options.outline ?? true,
      generateTaggedPDF: options.tagged ?? true,
      transferMode: 'ReturnAsStream',
    });
    const chunks: Buffer[] = [];
    for (;;) {
      const { data, base64Encoded, eof } = await this.#send('IO.read', { handle: stream, size: 8 << 20 });
      if (data) chunks.push(Buffer.from(data, base64Encoded ? 'base64' : 'utf8'));
      if (eof) break;
    }
    await this.#send('IO.close', { handle: stream }).catch(() => {});
    return Buffer.concat(chunks);
  }

  async close(): Promise<void> {
    await this.#conn.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}
