import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { ignoreError, toErrorMessage } from '../utils/errors.js';
import { normalizePaperFormat, parseMargin } from '../utils/validation.js';
import { waitForDynamicContent } from './dynamic.js';
import { rewritePdfFileUrisToRelative } from './pdf-links.js';
import { createRenderServer, type RenderHttpServer } from './server.js';

const RENDER_TIMEOUT_MS = 60000;

interface PdfRuntimeOptions {
  executablePath?: string;
  launchBrowser?: () => Promise<Browser>;
}

interface PdfRenderInput {
  outputPath: string;
  basePath?: string;
  assetCacheDir?: string;
  maxConcurrentPages: number;
  margin: string;
  format: string;
  headerTemplate?: string | null;
  footerTemplate?: string | null;
  buildHtml: (context: { sourceBaseUrl?: string; serverBaseUrl: string }) => Promise<string>;
}

export class PdfRenderRuntime {
  private browser: Browser | null = null;
  private readonly renderServers = new Map<string, RenderHttpServer>();
  private readonly renderServerInitializers = new Map<string, Promise<RenderHttpServer>>();
  private initializing: Promise<void> | null = null;
  private activePages = 0;
  private readonly pageWaiters: Array<() => void> = [];

  constructor(private readonly options: PdfRuntimeOptions = {}) {}

  async init(): Promise<void> {
    if (this.browser) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      try {
        this.browser = this.options.launchBrowser
          ? await this.options.launchBrowser()
          : await puppeteer.launch({
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
    const requestedCacheDir = assetCacheDir ?? '';
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

  async renderPdf(input: PdfRenderInput): Promise<void> {
    await this.init();
    await mkdir(dirname(input.outputPath), { recursive: true });

    let page: Page | null = null;
    let documentHandle: {
      url: string;
      sourceBaseUrl?: string;
      setHtml: (html: string) => void;
      dispose: () => void;
    } | null = null;
    let renderServerBaseUrl: string | null = null;

    try {
      page = await this.acquirePage(input.maxConcurrentPages);
      const renderServer = await this.getRenderServer(input.assetCacheDir);
      renderServerBaseUrl = renderServer.baseUrl;
      documentHandle = renderServer.registerDocument(input.basePath);

      const html = await input.buildHtml({
        sourceBaseUrl: documentHandle.sourceBaseUrl,
        serverBaseUrl: renderServer.baseUrl
      });
      documentHandle.setHtml(html);

      await page.emulateMediaType('print');
      await page.goto(documentHandle.url, {
        waitUntil: 'domcontentloaded',
        timeout: RENDER_TIMEOUT_MS
      });
      await waitForDynamicContent(page);

      await page.pdf({
        path: input.outputPath,
        format: normalizePaperFormat(input.format),
        printBackground: true,
        margin: parseMargin(input.margin),
        waitForFonts: false,
        displayHeaderFooter: Boolean(input.headerTemplate || input.footerTemplate),
        headerTemplate: input.headerTemplate || '<span></span>',
        footerTemplate: input.footerTemplate || '<span></span>'
      });

      if (input.basePath) {
        await rewritePdfFileUrisToRelative(
          input.outputPath,
          input.basePath,
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
