/**
 * `mdpdf serve`: a small local web UI with an editor, live preview and exact
 * PDF preview/download.
 *
 * The server only listens on localhost by default, rejects requests whose
 * Host header is not the server itself (DNS rebinding) and requires a custom
 * header on every mutating request (which a foreign page cannot send without
 * a CORS preflight that is never granted).
 */
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findConfig, listMarkdown, loadConfig, UsageError } from '../config.ts';
import { Converter, type Job } from '../convert.ts';
import { previewCss, themeNames } from '../document.ts';
import { isMarkdownPath } from '../markdown/render-rules.ts';
import type { AssetResolver } from '../markdown/types.ts';
import { openTarget } from '../open.ts';
import { coerceOptions, mergeOptions, type ConvertOptions } from '../options.ts';
import { Vault } from '../vault.ts';
import { VERSION } from '../version.ts';

const HELP = `
mdpdf serve — web UI with editor, live preview and PDF export

Usage
  mdpdf serve [folder | file.md] [options]

Options
  -p, --port <n>       Port (default: 4400, or the next free one)
      --host <addr>    Interface to listen on (default: 127.0.0.1)
      --open           Open the UI in your browser
      --config <file>  Config file (default: nearest mdpdf.yaml / mdpdf.json)
      --chrome <path>  Chrome/Chromium/Edge executable
  -h, --help           Show this help
`;

const UI_DIR = fileURLToPath(new URL('./ui/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Absolute path ↔ `/fs/...` URL, keeping slashes so relative CSS urls work. */
function fsUrl(abs: string): string {
  const parts = abs.split(sep).map(encodeURIComponent);
  return '/fs' + (parts[0] === '' ? '' : '/') + parts.join('/');
}

function fsPath(urlPath: string): string {
  const parts = urlPath.slice('/fs/'.length).split('/').map(decodeURIComponent);
  return process.platform === 'win32' ? parts.join('\\') : '/' + parts.join('/');
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

interface RenderRequest {
  path?: string | null;
  source: string;
  options?: Record<string, unknown>;
}

export interface ServeOptions {
  root: string;
  initialFile: string | null;
  port: number;
  /** Try following ports when the requested one is taken. */
  portFallback: boolean;
  host: string;
  config?: Partial<ConvertOptions>;
  chrome?: string;
  quiet?: boolean;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/** UI-adjustable options and what they accept. */
const UI_OPTIONS = new Set(['theme', 'paper', 'landscape', 'toc', 'breaks', 'lineNumbers', 'fontSize', 'margin', 'footer', 'header', 'codeTheme', 'breakBefore']);

export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const root = resolve(opts.root);
  const converter = new Converter({ config: opts.config, chrome: opts.chrome, concurrency: 2 });
  converter.warmup();

  // Files the preview may load through /fs: everything the renderer referenced,
  // plus siblings of referenced stylesheets (fonts, images in relative url()s).
  const allowedFiles = new Set<string>();
  const allowedDirs = new Set<string>();
  const resolver: AssetResolver = {
    file(abs) {
      if (!allowedFiles.has(abs)) {
        allowedFiles.add(abs);
        if (extname(abs).toLowerCase() === '.css') allowedDirs.add(dirname(abs));
      }
      return fsUrl(abs);
    },
  };
  const canServe = (abs: string): boolean => {
    if (!MIME[extname(abs).toLowerCase()]) return false;
    if (allowedFiles.has(abs) || isInside(abs, root)) return true;
    for (const dir of allowedDirs) if (isInside(abs, dir)) return true;
    return false;
  };

  const toAbs = (rel: string): string => {
    const abs = resolve(root, rel);
    if (!isInside(abs, root)) throw new HttpError(403, 'Path is outside the served folder');
    return abs;
  };

  const jobFor = (req: RenderRequest, format: 'pdf' | 'html'): Job => {
    const file = req.path ? toAbs(req.path) : join(root, 'Untitled.md');
    const warnings: string[] = [];
    const picked: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.options ?? {})) if (UI_OPTIONS.has(k) && v !== '' && v !== null) picked[k] = v;
    const options = coerceOptions(picked, (m) => warnings.push(m), 'request');
    return { inputs: [{ file, source: req.source }], output: null, format, options };
  };

  const ui = await loadUi();
  let selfUrl = '';
  let allowedHosts = new Set<string>();

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowedHosts.has((req.headers.host ?? '').toLowerCase())) throw new HttpError(403, 'Forbidden host');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      if (req.headers['x-mdpdf'] !== '1') throw new HttpError(403, 'Missing X-Mdpdf header');
      const origin = req.headers.origin;
      if (origin && origin !== selfUrl) throw new HttpError(403, 'Forbidden origin');
    }

    if (path === '/' && method === 'GET') {
      const initial = opts.initialFile ? relative(root, opts.initialFile).split(sep).join('/') : null;
      const boot = {
        version: VERSION,
        root: basename(root) || root,
        rootPath: root,
        initialFile: initial,
        themes: themeNames(),
        defaults: pickUiDefaults(mergeOptions(opts.config)),
        fonts: fontCss(resolver),
      };
      const html = ui.html().replace('<!--BOOT-->', `<script>window.__MDPDF__ = ${JSON.stringify(boot).replace(/</g, '\\u003c')};</script>`);
      return send(res, 200, html, 'text/html; charset=utf-8', { 'cache-control': 'no-store' });
    }
    if (path === '/app.js') return send(res, 200, await ui.js(), MIME['.js']!, { 'cache-control': 'no-store' });
    if (path === '/app.css') return send(res, 200, ui.css(), MIME['.css']!, { 'cache-control': 'no-store' });
    if (path === '/favicon.svg') return send(res, 200, FAVICON, MIME['.svg']!);

    if (path === '/api/files' && method === 'GET') {
      const files = listMarkdown(root).map((f) => relative(root, f).split(sep).join('/'));
      return sendJson(res, { root: basename(root) || root, files });
    }

    if (path === '/api/file') {
      const rel = url.searchParams.get('path');
      if (!rel) throw new HttpError(400, 'Missing path');
      const abs = toAbs(rel);
      if (!isMarkdownPath(abs)) throw new HttpError(400, 'Only markdown files can be opened');
      if (method === 'GET') {
        const text = await readFile(abs, 'utf8').catch(() => {
          throw new HttpError(404, `Not found: ${rel}`);
        });
        return send(res, 200, text, 'text/markdown; charset=utf-8', { 'cache-control': 'no-store' });
      }
      if (method === 'PUT') {
        const body = await readBody(req, 20 << 20);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, body);
        Vault.invalidate();
        return sendJson(res, { ok: true, mtime: (await stat(abs)).mtimeMs });
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (path === '/api/render' && method === 'POST') {
      const body = parseJson<RenderRequest>(await readBody(req, 20 << 20));
      const start = performance.now();
      const job = jobFor(body, 'html');
      const rendered = await converter.renderHtml(job, {
        resolver,
        resolverKey: 'http',
        sourceLines: true,
        extraHead: '',
      });
      // Screen styles depend on the effective paper/margins, so add them after rendering.
      const html = rendered.html.replace('</head>', `<style>${previewCss(rendered.options)}</style>\n</head>`);
      return sendJson(res, {
        html,
        title: rendered.options.title,
        options: pickUiDefaults(rendered.options),
        warnings: [...new Set(rendered.warnings)],
        ms: Math.round(performance.now() - start),
      });
    }

    if (path === '/api/pdf' && method === 'POST') {
      const body = parseJson<RenderRequest>(await readBody(req, 20 << 20));
      const result = await converter.convert(jobFor(body, 'pdf'));
      const name = (body.path ? basename(body.path, extname(body.path)) : 'Untitled') + '.pdf';
      return send(res, 200, result.bytes, 'application/pdf', {
        'cache-control': 'no-store',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
        'x-pages': String(result.pages),
        'x-ms': String(Math.round(result.ms)),
        'x-warnings': encodeURIComponent(JSON.stringify(result.warnings)),
      });
    }

    if (path === '/api/events' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (path.startsWith('/fs/') && (method === 'GET' || method === 'HEAD')) {
      const abs = fsPath(path);
      if (!canServe(abs)) throw new HttpError(404, 'Not found');
      let data: Buffer;
      try {
        if (!statSync(abs).isFile()) throw new Error('not a file');
        data = await readFile(abs);
      } catch {
        throw new HttpError(404, 'Not found');
      }
      const etag = `"${statSync(abs).mtimeMs.toString(36)}-${data.length.toString(36)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      return send(res, 200, data, MIME[extname(abs).toLowerCase()]!, { etag, 'cache-control': 'no-cache' });
    }

    throw new HttpError(404, 'Not found');
  }

  // Live updates: tell the UI about changed files.
  const clients = new Set<ServerResponse>();
  const pending = new Map<string, NodeJS.Timeout>();
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(root, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const rel = filename.toString().split(sep).join('/');
      if (rel.split('/').some((part) => part.startsWith('.') || part === 'node_modules')) return;
      const key = `${event}:${rel}`;
      clearTimeout(pending.get(key));
      pending.set(
        key,
        setTimeout(() => {
          pending.delete(key);
          const exists = existsSync(join(root, rel));
          const type = event === 'rename' ? 'tree' : 'change';
          broadcast({ type, path: rel, exists });
          if (event === 'rename') Vault.invalidate();
        }, 80),
      );
    });
    watcher.on('error', () => {});
  } catch {
    // watching is best effort (e.g. too many files)
  }
  function broadcast(data: unknown): void {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(msg);
  }

  const port = await listen(server, opts.port, opts.host, opts.portFallback);
  const displayHost = opts.host === '127.0.0.1' || opts.host === '::1' || opts.host === '0.0.0.0' ? 'localhost' : opts.host;
  selfUrl = `http://${displayHost}:${port}`;
  allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `${opts.host}:${port}`.toLowerCase()]);

  return {
    url: selfUrl,
    async close() {
      watcher?.close();
      for (const c of clients) c.end();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await converter.close();
    },
  };
}

function pickUiDefaults(o: ConvertOptions): Record<string, unknown> {
  return {
    theme: o.theme,
    paper: o.paper,
    landscape: o.landscape,
    toc: o.toc,
    breaks: o.breaks,
    lineNumbers: o.lineNumbers,
  };
}

/** @font-face rules for the UI itself (Inter + JetBrains Mono). */
function fontCss(resolver: AssetResolver): string {
  const faces: Array<[string, string, string]> = [
    ['Inter', '400', '@fontsource/inter/files/inter-latin-400-normal.woff2'],
    ['Inter', '500', '@fontsource/inter/files/inter-latin-500-normal.woff2'],
    ['Inter', '600', '@fontsource/inter/files/inter-latin-600-normal.woff2'],
    ['JetBrains Mono', '400', '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2'],
    ['JetBrains Mono', '700', '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2'],
  ];
  const out: string[] = [];
  for (const [family, weight, spec] of faces) {
    try {
      const path = fileURLToPath(import.meta.resolve(spec));
      out.push(`@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:swap;src:url(${resolver.file(path)}) format('woff2')}`);
    } catch {
      // font missing: system fonts are fine
    }
  }
  return out.join('\n');
}

interface Ui {
  html(): string;
  css(): string;
  js(): Promise<string>;
}

/**
 * The UI is plain HTML/CSS plus one TypeScript entry bundled with esbuild.
 * Published packages ship the prebuilt bundle (dist/ui/app.js); from a source
 * checkout it is built on demand and rebuilt when the sources change.
 */
async function loadUi(): Promise<Ui> {
  // Running from source (src/server/ui has the TypeScript entry) or from dist/.
  const dev = existsSync(join(UI_DIR, 'app.ts'));
  const read = (name: string) => readFileSync(join(UI_DIR, name), 'utf8');
  let cached: { js: string; stamp: number } | null = null;
  const stamp = () => {
    let latest = 0;
    for (const f of ['app.ts', 'editor.ts', 'preview.ts']) {
      try {
        latest = Math.max(latest, statSync(join(UI_DIR, f)).mtimeMs);
      } catch {
        // optional file
      }
    }
    return latest;
  };
  return {
    html: () => read('index.html'),
    css: () => read('app.css'),
    async js() {
      if (!dev) return readFileSync(join(UI_DIR, 'app.js'), 'utf8');
      const now = stamp();
      if (cached && cached.stamp === now) return cached.js;
      let esbuild: typeof import('esbuild');
      try {
        esbuild = await import('esbuild');
      } catch {
        throw new HttpError(500, 'The web UI bundle is missing. Run "npm run build" (or install esbuild for development).');
      }
      const result = await esbuild.build({
        entryPoints: [join(UI_DIR, 'app.ts')],
        bundle: true,
        format: 'esm',
        target: ['chrome115', 'firefox115', 'safari16'],
        minify: true,
        write: false,
        legalComments: 'none',
      });
      cached = { js: result.outputFiles[0]!.text, stamp: now };
      return cached.js;
    },
  };
}

function listen(server: ReturnType<typeof createServer>, port: number, host: string, fallback: boolean): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let attempt = 0;
    const tryPort = (p: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && fallback && attempt < 20) {
          attempt++;
          tryPort(p + 1);
        } else {
          reject(err.code === 'EADDRINUSE' ? new UsageError(`Port ${p} is already in use (try --port)`) : err);
        }
      };
      server.once('error', onError);
      server.listen(p, host, () => {
        server.off('error', onError);
        resolvePort((server.address() as AddressInfo).port);
      });
    };
    tryPort(port);
  });
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, data: unknown): void {
  send(res, 200, JSON.stringify(data), 'application/json', { 'cache-control': 'no-store' });
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="5" y="2" width="22" height="28" rx="3" fill="#4f5bd5"/><path d="M10 21V11l3.5 4 3.5-4v10M20 11v10m0 0-2.5-2.5M20 21l2.5-2.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export async function runServe(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      open: { type: 'boolean' },
      config: { type: 'string' },
      chrome: { type: 'string' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP.trimStart());
    return 0;
  }
  if (positionals.length > 1) throw new UsageError('serve takes a single folder or file');
  const target = resolve(positionals[0] ?? '.');
  if (!existsSync(target)) throw new UsageError(`Not found: ${positionals[0]}`);
  const isDir = statSync(target).isDirectory();
  if (!isDir && !isMarkdownPath(target)) throw new UsageError(`Not a markdown file: ${positionals[0]}`);
  const root = isDir ? target : dirname(target);

  const port = values.port ? Number(values.port) : 4400;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be a number between 0 and 65535');

  const warnings: string[] = [];
  const configPath = values.config ? resolve(values.config) : findConfig(root);
  if (values.config && !existsSync(configPath!)) throw new UsageError(`Config file not found: ${values.config}`);
  const config = configPath ? await loadConfig(configPath, (m) => warnings.push(m)) : undefined;
  for (const w of warnings) process.stderr.write(`warning ${w}\n`);

  const running = await startServer({
    root,
    initialFile: isDir ? null : target,
    port,
    portFallback: !values.port,
    host: values.host ?? '127.0.0.1',
    config,
    chrome: values.chrome,
  });
  process.stderr.write(`mdpdf web UI running at ${running.url}\nServing ${root}\nPress Ctrl+C to stop.\n`);
  if (values.open) openTarget(running.url);

  await new Promise<void>((resolveStop) => {
    const stop = () => resolveStop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await running.close();
  return 0;
}

