import type { Token } from 'marked';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { mkdir, readFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
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
import { resolveRuntimeAssetSources } from './assets/resolve.js';
import { ignoreError, toErrorMessage } from './utils/errors.js';
import { waitForDynamicContent } from './render/dynamic.js';
import { rewritePdfFileUrisToRelative } from './render/pdf-links.js';
import { createRenderServer, type RenderHttpServer } from './render/server.js';

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

interface RuntimeRenderOptions extends RendererOptions {
  margin: string;
  format: NonNullable<RendererOptions['format']>;
  assetMode: NonNullable<RendererOptions['assetMode']>;
  allowNetworkFallback: NonNullable<RendererOptions['allowNetworkFallback']>;
  maxConcurrentPages: NonNullable<RendererOptions['maxConcurrentPages']>;
}

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
