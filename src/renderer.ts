import type { Token } from 'marked';
import { PDFDocument, PDFName, PDFDict, PDFString, PDFHexString } from 'pdf-lib';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, extname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import GithubSlugger from 'github-slugger';
import type { CustomToken, RendererOptions } from './types.js';
import { parseFrontmatter } from './markdown/frontmatter.js';
import { hasMathSyntax, protectMath } from './markdown/math.js';
import { hasMermaidSyntax } from './markdown/mermaid.js';
import { createMarkedInstance } from './markdown/marked.js';
import { generateToc } from './markdown/toc.js';
import { renderTemplate } from './html/template.js';
import {
  DEFAULT_MARGIN,
  DEFAULT_PAPER_FORMAT,
  normalizeMaxConcurrentPages,
  normalizePaperFormat,
  normalizeTocDepth,
  parseMargin
} from './utils/validation.js';
import { RUNTIME_ASSET_ROUTES, resolveRuntimeAssetSources } from './assets/resolve.js';
import { getRuntimeAssetPaths } from './assets/manager.js';
import { ignoreError, toErrorMessage } from './utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (pathValue: string) => readFile(join(__dirname, pathValue), 'utf-8');
const stylesPromise = Promise.all([read('styles/default.css'), read('styles/github.css')]);

const DEFAULT_RENDERER_OPTIONS: Readonly<{
  margin: string;
  format: NonNullable<RendererOptions['format']>;
  linkTargetFormat: NonNullable<RendererOptions['linkTargetFormat']>;
  assetMode: NonNullable<RendererOptions['assetMode']>;
  allowNetworkFallback: NonNullable<RendererOptions['allowNetworkFallback']>;
  maxConcurrentPages: NonNullable<RendererOptions['maxConcurrentPages']>;
}> = {
  margin: DEFAULT_MARGIN,
  format: DEFAULT_PAPER_FORMAT,
  linkTargetFormat: 'pdf',
  assetMode: 'auto',
  allowNetworkFallback: true,
  maxConcurrentPages: 8
};

const RENDER_TIMEOUT_MS = 60000;
const SOURCE_ROUTE_PREFIX = '/__convpdf_source/';
const DOCUMENT_ROUTE_PREFIX = '/document/';
const DOCUMENT_ROUTE_PATTERN = new RegExp(`^${DOCUMENT_ROUTE_PREFIX}([a-f0-9]+)\\.html$`, 'i');
const FILE_URI_MARKER = 'file:///';
const FILE_URI_HEX_MARKER = '66696c653a2f2f2f';
const SOURCE_ROUTE_HEX_MARKER = '2f5f5f636f6e767064665f736f757263652f';

interface RuntimeRenderOptions extends RendererOptions {
  margin: string;
  format: NonNullable<RendererOptions['format']>;
  assetMode: NonNullable<RendererOptions['assetMode']>;
  allowNetworkFallback: NonNullable<RendererOptions['allowNetworkFallback']>;
  maxConcurrentPages: NonNullable<RendererOptions['maxConcurrentPages']>;
}

interface RenderHttpServer {
  baseUrl: string;
  registerDocument: (sourceBasePath?: string) => {
    url: string;
    sourceBaseUrl?: string;
    setHtml: (html: string) => void;
    dispose: () => void;
  };
  close: () => Promise<void>;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};
const RUNTIME_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const mergeOptions = (base: RendererOptions, overrides: RendererOptions): RuntimeRenderOptions => {
  const merged = { ...DEFAULT_RENDERER_OPTIONS, ...base, ...overrides };
  const maxConcurrentPagesRaw = merged.maxConcurrentPages;
  const maxConcurrentPages =
    typeof maxConcurrentPagesRaw === 'number'
      ? normalizeMaxConcurrentPages(maxConcurrentPagesRaw)
      : DEFAULT_RENDERER_OPTIONS.maxConcurrentPages;
  return {
    ...merged,
    margin: merged.margin ?? DEFAULT_RENDERER_OPTIONS.margin,
    format: merged.format ?? DEFAULT_RENDERER_OPTIONS.format,
    assetMode: merged.assetMode ?? DEFAULT_RENDERER_OPTIONS.assetMode,
    allowNetworkFallback:
      merged.allowNetworkFallback ?? DEFAULT_RENDERER_OPTIONS.allowNetworkFallback,
    maxConcurrentPages
  };
};

const resolveRuntimeAssetPlan = async (
  opts: RuntimeRenderOptions,
  usage: { math: boolean; mermaid: boolean },
  serverBaseUrl?: string
): Promise<{
  mathJaxSrc?: string;
  mermaidSrc?: string;
  mathJaxBaseUrl?: string;
  mathJaxFontBaseUrl?: string;
  warning?: string;
}> => {
  if (!usage.math && !usage.mermaid) {
    return {};
  }

  const needsMathAssetResolution = usage.math && !opts.mathJaxSrc;
  const needsMermaidAssetResolution = usage.mermaid && !opts.mermaidSrc;
  if (!needsMathAssetResolution && !needsMermaidAssetResolution) {
    return {
      mathJaxSrc: opts.mathJaxSrc,
      mermaidSrc: opts.mermaidSrc,
      mathJaxBaseUrl: opts.mathJaxBaseUrl,
      mathJaxFontBaseUrl: opts.mathJaxFontBaseUrl
    };
  }

  const resolved = await resolveRuntimeAssetSources({
    mode: opts.assetMode,
    cacheDir: opts.assetCacheDir,
    allowNetworkFallback: opts.allowNetworkFallback,
    serverBaseUrl
  });

  return {
    mathJaxSrc: opts.mathJaxSrc ?? resolved.mathJaxSrc,
    mermaidSrc: opts.mermaidSrc ?? resolved.mermaidSrc,
    mathJaxBaseUrl: opts.mathJaxBaseUrl ?? resolved.mathJaxBaseUrl,
    mathJaxFontBaseUrl: opts.mathJaxFontBaseUrl ?? resolved.mathJaxFontBaseUrl,
    warning: resolved.warning
  };
};

const reorderFootnotesToEnd = (tokens: CustomToken[]): void => {
  const footnoteIndex = tokens.findIndex((token) => token.type === 'footnotes');
  if (footnoteIndex < 0) return;
  const [footnotes] = tokens.splice(footnoteIndex, 1);
  if (footnotes) tokens.push(footnotes);
};

const restoreMathInHeadingTokens = (
  tokens: CustomToken[],
  restoreMath: (value: string) => string
): void => {
  for (const token of tokens) {
    if (token.type === 'heading' && typeof token.text === 'string') {
      token.text = restoreMath(token.text);
    }
    if (token.tokens?.length) {
      restoreMathInHeadingTokens(token.tokens, restoreMath);
    }
  }
};

const waitForDynamicContent = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    const waitUntil = async (
      check: () => boolean,
      timeoutMs: number,
      label: string
    ): Promise<void> => {
      const startedAt = Date.now();
      while (!check()) {
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(`${label} did not initialize within ${timeoutMs}ms`);
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
    };

    const images = Array.from(document.querySelectorAll('img'));
    await Promise.all(
      images.map(async (image) => {
        if (image.complete) return;
        await new Promise<void>((resolveImage) => {
          const complete = () => {
            resolveImage();
          };
          image.addEventListener('load', complete, { once: true });
          image.addEventListener('error', complete, { once: true });
          setTimeout(complete, 5000);
        });
      })
    );

    const win = window as Window & {
      MathJax?: {
        startup?: { promise?: Promise<void> };
        typesetPromise?: () => Promise<void>;
      };
      mermaid?: {
        run?: (options?: { querySelector?: string; suppressErrors?: boolean }) => Promise<void>;
      };
    };

    if (document.getElementById('MathJax-script')) {
      await waitUntil(
        () => typeof win.MathJax?.typesetPromise === 'function' || !!win.MathJax?.startup?.promise,
        10000,
        'MathJax'
      );
      if (win.MathJax?.startup?.promise) {
        await win.MathJax.startup.promise;
      }
      // After startup, typesetPromise should be available. Wait for it explicitly
      // so that math is never silently skipped if startup resolved just before typesetPromise
      // was registered.
      if (typeof win.MathJax?.typesetPromise !== 'function') {
        await waitUntil(
          () => typeof win.MathJax?.typesetPromise === 'function',
          5000,
          'MathJax typesetPromise'
        );
      }
      const mathjax = win.MathJax;
      if (mathjax && typeof mathjax.typesetPromise === 'function') {
        await mathjax.typesetPromise();
      }
    }

    if (document.getElementById('Mermaid-script') && document.querySelector('.mermaid')) {
      await waitUntil(() => typeof win.mermaid?.run === 'function', 10000, 'Mermaid');
      if (document.fonts && 'ready' in document.fonts) {
        await document.fonts.ready;
      }
      await win.mermaid?.run?.({ querySelector: '.mermaid', suppressErrors: false });
    }

    if (document.fonts && 'ready' in document.fonts) {
      await document.fonts.ready;
    }

    await new Promise<void>((resolveFrame) => {
      requestAnimationFrame(() => {
        resolveFrame();
      });
    });
  });
};

const normalizeRelativeHref = (basePath: string, targetPath: string, suffix: string): string => {
  let relPath = relative(resolve(basePath), targetPath).split('\\').join('/');
  if (!relPath) relPath = '.';
  if (!relPath.startsWith('.') && !relPath.startsWith('/')) {
    relPath = `./${relPath}`;
  }
  return `${relPath}${suffix}`;
};

const toRelativeHrefFromFileUrl = (href: string, basePath: string): string | null => {
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== 'file:') return null;
    const targetPath = fileURLToPath(parsed);
    return normalizeRelativeHref(basePath, targetPath, `${parsed.search}${parsed.hash}`);
  } catch {
    return null;
  }
};

const toRelativeHrefFromServerUrl = (
  href: string,
  basePath: string,
  renderServerBaseUrl: string
): string | null => {
  try {
    const parsed = new URL(href);
    const serverBase = new URL(renderServerBaseUrl);
    if (parsed.origin !== serverBase.origin) return null;

    if (!parsed.pathname.startsWith(SOURCE_ROUTE_PREFIX)) return null;

    const sourcePathWithKey = parsed.pathname.slice(SOURCE_ROUTE_PREFIX.length);
    const separatorIndex = sourcePathWithKey.indexOf('/');
    if (separatorIndex < 0) return null;
    const sourceRelative = decodeURIComponent(sourcePathWithKey.slice(separatorIndex + 1));
    const targetPath = resolve(basePath, sourceRelative);
    return normalizeRelativeHref(basePath, targetPath, `${parsed.search}${parsed.hash}`);
  } catch {
    return null;
  }
};

const rewritePdfFileUrisToRelative = async (
  outputPath: string,
  basePath: string,
  renderServerBaseUrl?: string
): Promise<void> => {
  // Parse the full PDF to handle both PDFString and PDFHexString-encoded URIs.
  // Byte-scanning for '/URI (file:///' would miss hex-encoded annotations.
  // We rely on the `!changed` guard below to avoid re-saving when unneeded.
  const pdfBytes = await readFile(outputPath);
  const pdfText = pdfBytes.toString('latin1').toLowerCase();
  const hasFileUriCandidate =
    pdfText.includes(FILE_URI_MARKER) || pdfText.includes(FILE_URI_HEX_MARKER);
  const hasServerUriCandidate =
    Boolean(renderServerBaseUrl) &&
    (pdfText.includes(SOURCE_ROUTE_PREFIX) || pdfText.includes(SOURCE_ROUTE_HEX_MARKER));
  if (!hasFileUriCandidate && !hasServerUriCandidate) {
    return;
  }

  const pdfDocument = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const actionKey = PDFName.of('A');
  const uriKey = PDFName.of('URI');
  let changed = false;

  for (const page of pdfDocument.getPages()) {
    const annotations = page.node.Annots();
    if (!annotations) continue;

    for (let index = 0; index < annotations.size(); index++) {
      const annotation = annotations.lookup(index, PDFDict);
      const action = annotation.lookupMaybe(actionKey, PDFDict);
      if (!action) continue;

      const uri = action.lookupMaybe(uriKey, PDFString, PDFHexString);
      if (!uri) continue;

      const href = uri.decodeText();
      const relativeHrefFromFile = toRelativeHrefFromFileUrl(href, basePath);
      const relativeHrefFromServer = renderServerBaseUrl
        ? toRelativeHrefFromServerUrl(href, basePath, renderServerBaseUrl)
        : null;
      const relativeHref = relativeHrefFromFile ?? relativeHrefFromServer;

      if (!relativeHref || href === relativeHref) continue;

      action.set(uriKey, PDFString.of(relativeHref));
      changed = true;
    }
  }

  if (!changed) return;

  const rewritten = await pdfDocument.save({
    updateFieldAppearances: false,
    useObjectStreams: false
  });
  await writeFile(outputPath, rewritten);
};

const sendError = (res: ServerResponse, code: number): void => {
  res.statusCode = code;
  res.end(code === 404 ? 'Not Found' : 'Internal Server Error');
};

const serveFile = async (
  res: ServerResponse,
  absolutePath: string,
  options?: { cacheControl?: string; memoryCache?: Map<string, Buffer> }
): Promise<void> => {
  try {
    const cachedBuffer = options?.memoryCache?.get(absolutePath);
    const buffer = cachedBuffer ?? (await readFile(absolutePath));
    if (!cachedBuffer && options?.memoryCache) {
      options.memoryCache.set(absolutePath, buffer);
    }
    res.statusCode = 200;
    res.setHeader(
      'Content-Type',
      MIME_TYPES[extname(absolutePath).toLowerCase()] ?? 'application/octet-stream'
    );
    if (options?.cacheControl) {
      res.setHeader('Cache-Control', options.cacheControl);
    }
    res.end(buffer);
  } catch {
    sendError(res, 404);
  }
};

const resolveUnder = (basePath: string, relativePathValue: string): string | null => {
  const candidate = resolve(basePath, relativePathValue);
  const normalizedBase = resolve(basePath);
  if (
    candidate === normalizedBase ||
    candidate.startsWith(`${normalizedBase}${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    return candidate;
  }
  return null;
};

const createRenderServer = async (options: {
  assetCacheDir?: string;
}): Promise<RenderHttpServer> => {
  const runtimePaths = getRuntimeAssetPaths(options.assetCacheDir);
  const documents = new Map<string, { html: string; sourceBasePath?: string }>();
  const runtimeAssetCache = new Map<string, Buffer>();
  let nextDocumentId = 1;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(requestUrl.pathname);

    const documentMatch = DOCUMENT_ROUTE_PATTERN.exec(pathname);
    if (documentMatch) {
      const documentId = documentMatch[1] ?? '';
      const document = documents.get(documentId);
      if (!document) {
        sendError(res, 404);
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(document.html);
      return;
    }

    if (pathname.startsWith(SOURCE_ROUTE_PREFIX)) {
      const sourcePath = pathname.slice(SOURCE_ROUTE_PREFIX.length);
      const separatorIndex = sourcePath.indexOf('/');
      if (separatorIndex < 0) {
        sendError(res, 404);
        return;
      }
      const documentId = sourcePath.slice(0, separatorIndex);
      const relPath = sourcePath.slice(separatorIndex + 1);
      const document = documents.get(documentId);
      if (!document?.sourceBasePath) {
        sendError(res, 404);
        return;
      }
      const absolute = resolveUnder(document.sourceBasePath, relPath);
      if (!absolute) {
        sendError(res, 404);
        return;
      }
      await serveFile(res, absolute);
      return;
    }

    if (pathname.startsWith(`${RUNTIME_ASSET_ROUTES.mathJaxBase}/`)) {
      const relPath = pathname.slice(`${RUNTIME_ASSET_ROUTES.mathJaxBase}/`.length);
      const absolute = resolveUnder(runtimePaths.mathJaxDir, relPath);
      if (!absolute) {
        sendError(res, 404);
        return;
      }
      await serveFile(res, absolute, {
        cacheControl: RUNTIME_CACHE_CONTROL,
        memoryCache: runtimeAssetCache
      });
      return;
    }

    if (pathname.startsWith(`${RUNTIME_ASSET_ROUTES.mathJaxFontBase}/`)) {
      const relPath = pathname.slice(`${RUNTIME_ASSET_ROUTES.mathJaxFontBase}/`.length);
      const absolute = resolveUnder(runtimePaths.mathJaxFontDir, relPath);
      if (!absolute) {
        sendError(res, 404);
        return;
      }
      await serveFile(res, absolute, {
        cacheControl: RUNTIME_CACHE_CONTROL,
        memoryCache: runtimeAssetCache
      });
      return;
    }

    if (pathname === RUNTIME_ASSET_ROUTES.mermaidPath) {
      await serveFile(res, runtimePaths.mermaidPath, {
        cacheControl: RUNTIME_CACHE_CONTROL,
        memoryCache: runtimeAssetCache
      });
      return;
    }

    sendError(res, 404);
  };

  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      sendError(res, 500);
    });
  });

  await new Promise<void>((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectStart);
      resolveStart();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolveClose) => {
      server.close(() => {
        resolveClose();
      });
    });
    throw new Error('Failed to start render server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    registerDocument: (sourceBasePath?: string) => {
      const id = String(nextDocumentId);
      nextDocumentId += 1;
      documents.set(id, { html: '', sourceBasePath });
      return {
        url: `http://127.0.0.1:${address.port}${DOCUMENT_ROUTE_PREFIX}${id}.html`,
        sourceBaseUrl: sourceBasePath
          ? `http://127.0.0.1:${address.port}${SOURCE_ROUTE_PREFIX}${id}/`
          : undefined,
        setHtml: (html: string) => {
          const existing = documents.get(id);
          if (existing) {
            existing.html = html;
          }
        },
        dispose: () => {
          documents.delete(id);
        }
      };
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      })
  };
};

export class Renderer {
  private options: RendererOptions;
  private browser: Browser | null = null;
  private readonly renderServers = new Map<string, RenderHttpServer>();
  private readonly renderServerInitializers = new Map<string, Promise<RenderHttpServer>>();
  private readonly cssCache = new Map<string, Promise<string>>();
  private initializing: Promise<void> | null = null;
  private activePages = 0;
  private readonly pageWaiters: Array<() => void> = [];

  constructor(options: RendererOptions = {}) {
    this.options = { ...DEFAULT_RENDERER_OPTIONS, ...options };
  }

  async init(): Promise<void> {
    if (this.browser) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      try {
        this.browser = await puppeteer.launch({
          headless: true,
          executablePath: this.options.executablePath ?? process.env.PUPPETEER_EXECUTABLE_PATH,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
      } catch (error: unknown) {
        const message = toErrorMessage(error);
        throw new Error(
          `Failed to launch browser: ${message}\n\n` +
            'See the Troubleshooting section in README for common issues and solutions:\n' +
            'https://github.com/mohamed-chs/convpdf#troubleshooting',
          { cause: error }
        );
      } finally {
        this.initializing = null;
      }
    })();

    return this.initializing;
  }

  async close(): Promise<void> {
    if (this.initializing) {
      await this.initializing.catch(ignoreError);
    }
    if (this.renderServerInitializers.size > 0) {
      await Promise.allSettled([...this.renderServerInitializers.values()]);
      this.renderServerInitializers.clear();
    }
    if (this.renderServers.size > 0) {
      const servers = [...this.renderServers.values()];
      this.renderServers.clear();
      await Promise.all(
        servers.map(async (server) => {
          await server.close();
        })
      );
    }
    if (!this.browser) return;
    await this.browser.close();
    this.browser = null;
    this.activePages = 0;
    const waiters = this.pageWaiters.splice(0, this.pageWaiters.length);
    for (const wake of waiters) wake();
  }

  private async acquirePage(maxConcurrentPages: number): Promise<Page> {
    while (this.activePages >= maxConcurrentPages) {
      await new Promise<void>((resolveWaiter) => {
        this.pageWaiters.push(resolveWaiter);
      });
      if (!this.browser) {
        throw new Error('Browser was closed while waiting for an available page');
      }
    }
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    this.activePages += 1;
    try {
      return await this.browser.newPage();
    } catch (error: unknown) {
      this.activePages = Math.max(0, this.activePages - 1);
      const wakeNext = this.pageWaiters.shift();
      if (wakeNext) wakeNext();
      throw error;
    }
  }

  private releasePage(): void {
    this.activePages = Math.max(0, this.activePages - 1);
    const wakeNext = this.pageWaiters.shift();
    if (wakeNext) wakeNext();
  }

  private async getRenderServer(assetCacheDir?: string): Promise<RenderHttpServer> {
    const requestedCacheDir = assetCacheDir ? resolve(assetCacheDir) : '';
    const existingServer = this.renderServers.get(requestedCacheDir);
    if (existingServer) {
      return existingServer;
    }

    const existingInitializer = this.renderServerInitializers.get(requestedCacheDir);
    if (existingInitializer) {
      return existingInitializer;
    }

    const initializer = (async (): Promise<RenderHttpServer> => {
      const createdServer = await createRenderServer({ assetCacheDir });
      const activeServer = this.renderServers.get(requestedCacheDir);
      if (activeServer) {
        await createdServer.close();
        return activeServer;
      }
      this.renderServers.set(requestedCacheDir, createdServer);
      return createdServer;
    })();

    this.renderServerInitializers.set(requestedCacheDir, initializer);
    try {
      return await initializer;
    } finally {
      this.renderServerInitializers.delete(requestedCacheDir);
    }
  }

  private async readCustomCss(pathValue?: string | null): Promise<string> {
    if (!pathValue) return '';
    const absolutePath = resolve(pathValue);
    const cached = this.cssCache.get(absolutePath);
    if (cached) return cached;

    const readPromise = (async () => {
      try {
        return await readFile(absolutePath, 'utf-8');
      } catch (error: unknown) {
        const message = toErrorMessage(error);
        throw new Error(`Failed to read custom CSS at "${pathValue}": ${message}`, {
          cause: error
        });
      }
    })();

    this.cssCache.set(absolutePath, readPromise);
    try {
      return await readPromise;
    } catch (error: unknown) {
      this.cssCache.delete(absolutePath);
      throw error;
    }
  }

  private async buildRenderedDocument(
    markdown: string,
    opts: RuntimeRenderOptions,
    runtimeAssetsOverride?: {
      mathJaxSrc?: string;
      mermaidSrc?: string;
      mathJaxBaseUrl?: string;
      mathJaxFontBaseUrl?: string;
      warning?: string;
    },
    runtimeServerBaseUrl?: string
  ): Promise<string> {
    const parsedFrontmatter = parseFrontmatter(markdown);
    const { data, content } = parsedFrontmatter;
    for (const warning of parsedFrontmatter.warnings) {
      console.warn(warning);
    }

    const runtimeUsage = { math: hasMathSyntax(content), mermaid: hasMermaidSyntax(content) };
    const runtimeAssets =
      runtimeAssetsOverride ??
      (await resolveRuntimeAssetPlan(opts, runtimeUsage, runtimeServerBaseUrl));
    if (runtimeAssets.warning) {
      console.warn(runtimeAssets.warning);
    }
    const slugger = new GithubSlugger();
    const marked = createMarkedInstance(slugger, opts.linkTargetFormat);

    // Guard math content so Marked does not rewrite it.
    const {
      text: safeContent,
      restore: restoreMath,
      restoreHtml: restoreMathHtml
    } = protectMath(content);
    const tokens = marked.lexer(safeContent) as unknown as CustomToken[];

    // Restore math placeholders in heading text so the TOC renders real LaTeX, not tokens.
    // This must happen before walkTokens so heading IDs (used by the TOC) are based on the
    // restored math text. Marked's lexer does NOT run walkTokens automatically — it only
    // runs during parser(); but generateToc needs the IDs before parser() is called.
    restoreMathInHeadingTokens(tokens, restoreMath);
    if (marked.defaults.walkTokens) {
      void marked.walkTokens(tokens as unknown as Token[], marked.defaults.walkTokens);
    }

    reorderFootnotesToEnd(tokens);

    const tocDepth = normalizeTocDepth(
      typeof data.tocDepth === 'number' ? data.tocDepth : opts.tocDepth
    );
    const hasTocPlaceholder = tokens.some((token) => token.type === 'tocPlaceholder');
    const frontmatterToc = typeof data.toc === 'boolean' ? data.toc : undefined;
    const tocEnabled = opts.toc ?? frontmatterToc ?? false;
    const tocHtml = tocEnabled || hasTocPlaceholder ? generateToc(tokens, tocDepth) : '';

    let html = restoreMathHtml(marked.parser(tokens as unknown as Token[]));
    if (tocHtml) {
      if (html.includes('[[TOC_PLACEHOLDER]]')) {
        html = html.split('[[TOC_PLACEHOLDER]]').join(tocHtml);
      } else if (tocEnabled && !hasTocPlaceholder) {
        html = tocHtml + html;
      }
    }

    const customCssContent = await this.readCustomCss(opts.customCss);
    const [defaultCss, highlightCss] = await stylesPromise;
    const css = `${defaultCss}\n${highlightCss}\n${customCssContent}`;
    const title =
      typeof opts.title === 'string'
        ? opts.title
        : typeof data.title === 'string'
          ? data.title
          : 'Markdown Document';

    return renderTemplate({
      templatePath: opts.template,
      title,
      css,
      content: html,
      basePath: opts.basePath,
      baseHref: opts.baseHref,
      includeMathJax: runtimeUsage.math,
      includeMermaid: runtimeUsage.mermaid,
      mathJaxSrc: runtimeAssets.mathJaxSrc,
      mermaidSrc: runtimeAssets.mermaidSrc,
      mathJaxBaseUrl: runtimeAssets.mathJaxBaseUrl,
      mathJaxFontBaseUrl: runtimeAssets.mathJaxFontBaseUrl
    });
  }

  async renderHtml(markdown: string, overrides: RendererOptions = {}): Promise<string> {
    const opts = mergeOptions(this.options, overrides);
    return this.buildRenderedDocument(markdown, opts);
  }

  async generatePdf(
    markdown: string,
    outputPath: string,
    overrides: RendererOptions = {}
  ): Promise<void> {
    const opts = mergeOptions(this.options, overrides);

    await this.init();
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    await mkdir(dirname(outputPath), { recursive: true });

    let page: Page | null = null;
    let documentHandle: {
      url: string;
      sourceBaseUrl?: string;
      setHtml: (html: string) => void;
      dispose: () => void;
    } | null = null;
    let renderServerBaseUrl: string | null = null;

    try {
      page = await this.acquirePage(opts.maxConcurrentPages);
      const renderServer = await this.getRenderServer(opts.assetCacheDir);
      renderServerBaseUrl = renderServer.baseUrl;
      documentHandle = renderServer.registerDocument(opts.basePath);

      const html = await this.buildRenderedDocument(
        markdown,
        {
          ...opts,
          basePath: undefined,
          baseHref: documentHandle.sourceBaseUrl ?? opts.baseHref
        },
        undefined,
        renderServer.baseUrl
      );
      documentHandle.setHtml(html);

      await page.emulateMediaType('print');
      await page.goto(documentHandle.url, {
        waitUntil: 'domcontentloaded',
        timeout: RENDER_TIMEOUT_MS
      });
      await waitForDynamicContent(page);

      const margin = parseMargin(opts.margin);
      const format = normalizePaperFormat(
        typeof opts.format === 'string' ? opts.format : DEFAULT_PAPER_FORMAT
      );

      await page.pdf({
        path: outputPath,
        format,
        printBackground: true,
        margin,
        waitForFonts: false,
        displayHeaderFooter: Boolean(opts.headerTemplate || opts.footerTemplate),
        headerTemplate: opts.headerTemplate || '<span></span>',
        footerTemplate: opts.footerTemplate || '<span></span>'
      });

      if (opts.basePath) {
        await rewritePdfFileUrisToRelative(
          outputPath,
          opts.basePath,
          renderServerBaseUrl ?? undefined
        );
      }
    } finally {
      if (page) {
        await page.close().catch(ignoreError);
        this.releasePage();
      }
      if (documentHandle) {
        documentHandle.dispose();
      }
    }
  }
}
