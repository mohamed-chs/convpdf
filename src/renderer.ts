import type { RendererOptions } from './types.js';
import {
  DEFAULT_MARGIN,
  DEFAULT_PAPER_FORMAT,
  normalizeMaxConcurrentPages
} from './utils/validation.js';
import { DocumentCompiler, type DocumentCompileOptions } from './render/document.js';
import { PdfRenderRuntime } from './render/pdf-runtime.js';

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

interface RuntimeRenderOptions extends DocumentCompileOptions {
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

export class Renderer {
  private options: RendererOptions;
  private readonly documentCompiler = new DocumentCompiler();
  private readonly pdfRuntime: PdfRenderRuntime;

  constructor(options: RendererOptions = {}) {
    this.options = { ...DEFAULT_RENDERER_OPTIONS, ...options };
    this.pdfRuntime = new PdfRenderRuntime({ executablePath: this.options.executablePath });
  }

  async init(): Promise<void> {
    return this.pdfRuntime.init();
  }

  async close(): Promise<void> {
    return this.pdfRuntime.close();
  }

  async renderHtml(markdown: string, overrides: RendererOptions = {}): Promise<string> {
    const opts = mergeOptions(this.options, overrides);
    return this.documentCompiler.compile(markdown, opts);
  }

  async generatePdf(
    markdown: string,
    outputPath: string,
    overrides: RendererOptions = {}
  ): Promise<void> {
    const opts = mergeOptions(this.options, overrides);
    await this.pdfRuntime.renderPdf({
      outputPath,
      basePath: opts.basePath,
      assetCacheDir: opts.assetCacheDir,
      maxConcurrentPages: opts.maxConcurrentPages,
      margin: opts.margin,
      format: typeof opts.format === 'string' ? opts.format : DEFAULT_PAPER_FORMAT,
      headerTemplate: opts.headerTemplate,
      footerTemplate: opts.footerTemplate,
      buildHtml: ({ sourceBaseUrl, serverBaseUrl }) =>
        this.documentCompiler.compile(
          markdown,
          {
            ...opts,
            basePath: undefined,
            baseHref: sourceBaseUrl ?? opts.baseHref
          },
          undefined,
          serverBaseUrl
        )
    });
  }
}
