/**
 * The conversion engine: markdown file(s) → HTML → PDF.
 *
 * A Converter owns one headless browser (started lazily, in parallel with
 * markdown rendering) and a small pool of pages, so converting many files or
 * re-rendering in watch mode only pays the browser start-up cost once.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { trace } from './debug.ts';
import { buildHtml, type TemplateValues } from './document.ts';
import { parseFrontmatter, splitFrontmatter } from './markdown/frontmatter.ts';
import { createContext, renderMarkdown } from './markdown/index.ts';
import { renderToc } from './markdown/toc.ts';
import type { AssetResolver } from './markdown/types.ts';
import { coerceOptions, mergeOptions, type ConvertOptions } from './options.ts';
import { Browser, type Page } from './pdf/browser.ts';
import { destinationPages, pageCount, setMetadata } from './pdf/postprocess.ts';
import { Vault } from './vault.ts';
import { VERSION } from './version.ts';

export interface InputDoc {
  /** Absolute path of the markdown file (absent for stdin). */
  file?: string;
  /** Source text; read from `file` when omitted. */
  source?: string;
}

export interface Job {
  inputs: InputDoc[];
  /** Output path, or null to return the bytes without writing. */
  output: string | null;
  format: 'pdf' | 'html';
  /** Other markdown files converted in the same run (input path → output path), for cross-links. */
  siblings?: Map<string, string>;
  /** Per-job option overrides (highest precedence; used by the web UI). */
  options?: Partial<ConvertOptions>;
}

export interface RenderHtmlOptions {
  /** How local files are referenced from the HTML (default: file:// URLs). */
  resolver?: AssetResolver;
  /** Cache key distinguishing resolvers. */
  resolverKey?: string;
  /** Extra markup for <head>. */
  extraHead?: string;
  /** Annotate top-level blocks with data-line (source line numbers) for scroll sync. */
  sourceLines?: boolean;
}

export interface JobResult {
  output: string | null;
  bytes: Buffer;
  pages: number;
  warnings: string[];
  /** Local files the output depends on (sources, embeds, images, stylesheets). */
  deps: Set<string>;
  ms: number;
}

export interface ConverterOptions {
  /** Options from the command line (highest precedence). */
  cli?: Partial<ConvertOptions>;
  /** Options from a config file. */
  config?: Partial<ConvertOptions>;
  /** Browser executable override. */
  chrome?: string;
  /** Maximum number of documents printed concurrently. */
  concurrency?: number;
  /** An already launching browser to use (see the CLI's early start). */
  browser?: Promise<Browser>;
}

const fileResolver: AssetResolver = { file: (p) => pathToFileURL(p).href };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function stringField(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = data[key];
    if (v === undefined || v === null || v === '') continue;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (Array.isArray(v)) return v.map(String).join(', ');
    if (typeof v !== 'object') return String(v);
  }
  return undefined;
}

/** Document-level metadata and options from front matter. */
function frontmatterOptions(data: Record<string, unknown>, warn: (m: string) => void, source: string): Partial<ConvertOptions> {
  const own = data['mdpdf'] ?? data['pdf'];
  const opts: Partial<ConvertOptions> =
    own && typeof own === 'object' && !Array.isArray(own) ? coerceOptions(own as Record<string, unknown>, warn, `${source} front matter`) : {};
  const title = stringField(data, 'title');
  const author = stringField(data, 'author', 'authors');
  const subject = stringField(data, 'subject', 'description', 'summary');
  const date = stringField(data, 'date', 'created');
  const lang = stringField(data, 'lang', 'language');
  const kw = data['keywords'] ?? data['tags'];
  if (title && opts.title === undefined) opts.title = title;
  if (author && opts.author === undefined) opts.author = author;
  if (subject && opts.subject === undefined) opts.subject = subject;
  if (date && opts.date === undefined) opts.date = date;
  if (lang && opts.lang === undefined) opts.lang = lang;
  if (kw && opts.keywords === undefined) {
    const list = Array.isArray(kw) ? kw.map(String) : String(kw).split(/[,\s]+/);
    opts.keywords = list.map((k) => k.replace(/^#/, '').trim()).filter(Boolean);
  }
  return opts;
}

function frontmatterTable(data: Record<string, unknown>): string {
  const rows = Object.entries(data)
    .filter(([k]) => k !== 'mdpdf' && k !== 'pdf')
    .map(([k, v]) => {
      let value: string;
      if (v instanceof Date) value = v.toISOString().slice(0, 10);
      else if (Array.isArray(v)) value = v.map((x) => escapeHtml(String(x))).join(', ');
      else if (v && typeof v === 'object') value = escapeHtml(JSON.stringify(v));
      else value = escapeHtml(String(v ?? ''));
      return `<tr><th>${escapeHtml(k)}</th><td>${value}</td></tr>`;
    });
  return rows.length ? `<table class="frontmatter"><tbody>${rows.join('')}</tbody></table>\n` : '';
}

function titleBlock(data: Record<string, unknown>, options: ConvertOptions): string {
  const title = options.title;
  const subtitle = stringField(data, 'subtitle');
  const meta = [options.author, options.date].filter(Boolean).map((m) => `<span>${escapeHtml(m)}</span>`);
  return (
    '<header class="title-block">\n' +
    `<h1 class="title">${escapeHtml(title)}</h1>\n` +
    (subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>\n` : '') +
    (meta.length ? `<p class="meta">${meta.join('')}</p>\n` : '') +
    '</header>\n'
  );
}

function relativeHref(fromFile: string, toFile: string): string {
  const rel = relative(dirname(fromFile), toFile).split(/[\\/]/).map(encodeURIComponent).join('/');
  return rel || basename(toFile);
}

export class Converter {
  readonly options: ConverterOptions;
  #browser: Promise<Browser> | null = null;
  #instance: Browser | null = null;
  #idle: Page[] = [];
  #active = 0;
  #waiters: Array<() => void> = [];
  #tmpDir: string | null = null;
  #counter = 0;
  #closed = false;
  #warm: Promise<void> | null = null;

  constructor(options: ConverterOptions = {}) {
    this.options = options;
  }

  /**
   * Start the browser and open a first page now, in parallel with markdown
   * rendering (both are otherwise done on first use).
   */
  warmup(): void {
    this.#warm ??= this.#getBrowser()
      .then((b) => b.newPage())
      .then((page) => {
        if (this.#closed) page.close().catch(() => {});
        else this.#idle.push(page);
      })
      .catch(() => {});
  }

  #getBrowser(): Promise<Browser> {
    this.#browser ??= (this.options.browser ?? Browser.launch({ executablePath: this.options.chrome })).then((b) => {
      this.#instance = b;
      if (this.#closed) b.close();
      return b;
    });
    return this.#browser;
  }

  get #concurrency(): number {
    return Math.max(1, this.options.concurrency ?? 4);
  }

  async #acquire(): Promise<Page> {
    while (this.#active >= this.#concurrency) {
      await new Promise<void>((r) => this.#waiters.push(r));
    }
    this.#active++;
    try {
      if (!this.#idle.length && this.#warm) await this.#warm;
      const idle = this.#idle.pop();
      if (idle) return idle;
      const browser = await this.#getBrowser();
      return await browser.newPage();
    } catch (err) {
      this.#release(null);
      throw err;
    }
  }

  #release(page: Page | null): void {
    this.#active--;
    if (page) this.#idle.push(page);
    this.#waiters.shift()?.();
  }

  #tempFile(): string {
    this.#tmpDir ??= mkdtempSync(join(tmpdir(), 'mdpdf-'));
    return join(this.#tmpDir, `doc-${++this.#counter}.html`);
  }

  /**
   * Render a job to a complete HTML document (no browser involved).
   * Used for PDF output, `--html`, and the web preview.
   */
  async renderHtml(job: Job, render: RenderHtmlOptions = {}) {
    const { resolver = fileResolver, resolverKey = 'file', extraHead, sourceLines = false } = render;
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    const first = job.inputs[0];
    if (!first) throw new Error('No input documents');

    const sources = await Promise.all(
      job.inputs.map(async (doc) => doc.source ?? (await readFile(doc.file!, 'utf8'))),
    );
    const splits = sources.map((s) => splitFrontmatter(s));
    const fmData = await Promise.all(splits.map((s, i) => parseFrontmatter(s.raw, (m) => warn(`${job.inputs[i]!.file ?? 'stdin'}: ${m}`))));

    const baseFile = first.file;
    const baseDir = baseFile ? dirname(baseFile) : process.cwd();
    const vault = Vault.for(baseDir, true);
    const vaultLayer: Partial<ConvertOptions> = vault.isObsidian ? { breaks: !(vault.config.strictLineBreaks ?? false) } : {};
    const fmLayer = frontmatterOptions(fmData[0]!, warn, baseFile ? basename(baseFile) : 'stdin');
    const options = mergeOptions(vaultLayer, this.options.config, fmLayer, this.options.cli, job.options);

    // Cross-document links.
    const anchors = new Map<string, string>();
    job.inputs.forEach((doc, i) => doc.file && anchors.set(doc.file, `doc-${i + 1}`));
    const merged = job.inputs.length > 1;
    const output = job.output;
    const linkTarget = (abs: string): string | null => {
      if (merged && anchors.has(abs)) return `#${anchors.get(abs)}`;
      const sibling = job.siblings?.get(abs);
      if (sibling && output) return relativeHref(output, sibling);
      return null;
    };

    const ctx = createContext({
      options,
      resolver,
      vault,
      linkTarget,
      sourceLines,
    });

    const sections: string[] = [];
    for (let i = 0; i < job.inputs.length; i++) {
      const doc = job.inputs[i]!;
      const docOptions =
        i === 0 ? options : mergeOptions(vaultLayer, this.options.config, frontmatterOptions(fmData[i]!, warn, doc.file ?? ''), this.options.cli, job.options);
      // Per-document line-break behaviour; everything else follows the first document.
      ctx.options = { ...options, breaks: docOptions.breaks };
      ctx.lineOffset = splits[i]!.bodyLine;
      let html = (await renderMarkdown(splits[i]!.body, ctx, doc.file, doc.file ? dirname(doc.file) : baseDir)).html;
      if (options.showFrontmatter) html = frontmatterTable(fmData[i]!) + html;
      sections.push(merged ? `<section class="document" id="${anchors.get(doc.file!) ?? `doc-${i + 1}`}">\n${html}</section>\n` : html);
    }
    ctx.options = options;

    const firstH1 = ctx.headings.find((h) => h.level === 1)?.text;
    const fileTitle = baseFile ? basename(baseFile, extname(baseFile)) : 'Document';
    const startsWithH1 = /^\s*(<section[^>]*>\s*)?<h1[\s>]/.test(sections[0] ?? '');
    if (!options.title) options.title = firstH1 ?? fileTitle;

    let prefix = '';
    if (options.titleBlock && fmLayer.title && !startsWithH1 && !merged) prefix += titleBlock(fmData[0]!, options);
    if (options.toc) {
      const toc = renderToc(ctx.headings, options.tocDepth, options.tocTitle);
      if (toc) prefix += toc + '<div class="page-break"></div>\n';
    }
    let body = prefix + sections.join('');
    if (job.format === 'pdf' && options.tocPageNumbers) body = body.replace(/<nav class="toc">/g, '<nav class="toc has-page-numbers">');

    const templateValues: TemplateValues = {
      title: options.title,
      author: options.author,
      date: options.date || new Date().toISOString().slice(0, 10),
      file: baseFile ? basename(baseFile) : '',
    };
    for (const css of options.css) ctx.deps.add(resolve(baseDir, css));

    const html = buildHtml({
      title: options.title,
      body,
      options,
      features: ctx.features,
      resolver,
      resolverKey,
      baseDir,
      templateValues,
      extraHead,
    });
    warnings.push(...ctx.warnings);
    return { html, options, warnings, deps: ctx.deps, baseDir };
  }

  async convert(job: Job): Promise<JobResult> {
    if (this.#closed) throw new Error('Converter is closed');
    const start = performance.now();
    if (job.format === 'pdf') this.warmup();
    let t = trace('convert start');
    const rendered = await this.renderHtml(job);
    t = trace('html ready', t);
    const { options, warnings, deps } = rendered;

    let bytes: Buffer;
    let pages = 0;
    if (job.format === 'html') {
      bytes = Buffer.from(rendered.html, 'utf8');
    } else {
      const tmp = this.#tempFile();
      await writeFile(tmp, rendered.html);
      const page = await this.#acquire();
      t = trace('page acquired', t);
      let healthy = false;
      try {
        const pageWarnings = await page.load(pathToFileURL(tmp).href, options.timeout);
        t = trace('page loaded', t);
        warnings.push(...pageWarnings);
        bytes = await page.pdf();
        t = trace('printed', t);
        if (options.tocPageNumbers && rendered.html.includes('class="toc-page"')) {
          const dests = destinationPages(bytes);
          if (dests.size) {
            const map = Object.fromEntries(dests);
            await page.evaluate(
              `(() => { const m = ${JSON.stringify(map)}; for (const el of document.querySelectorAll('.toc-page[data-target]')) { const p = m[el.dataset.target]; if (p) el.textContent = String(p); } })()`,
            );
            bytes = await page.pdf();
            t = trace('printed with TOC page numbers', t);
          }
        }
        healthy = true;
      } finally {
        this.#release(healthy ? page : null);
        if (!healthy) page.close().catch(() => {});
        rmSync(tmp, { force: true });
      }
      bytes = setMetadata(bytes, {
        title: options.title,
        author: options.author || undefined,
        subject: options.subject || undefined,
        keywords: options.keywords,
        creator: `mdpdf ${VERSION}`,
        displayDocTitle: true,
      });
      pages = pageCount(bytes);
    }

    if (job.output) {
      await mkdir(dirname(job.output), { recursive: true });
      // Write atomically so PDF viewers never see a half-written file.
      const partial = `${job.output}.${process.pid}.partial`;
      await writeFile(partial, bytes);
      await rename(partial, job.output);
    }
    return { output: job.output, bytes, pages, warnings: [...new Set(warnings)], deps, ms: performance.now() - start };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const browser = this.#browser;
    this.#browser = null;
    if (browser) {
      try {
        await (await browser).close();
      } catch {
        // launch failed; nothing to close
      }
    }
    if (this.#tmpDir) rmSync(this.#tmpDir, { recursive: true, force: true });
  }

  /** Synchronous emergency cleanup (process exit / signals). */
  killSync(): void {
    this.#instance?.killSync();
    if (this.#tmpDir) rmSync(this.#tmpDir, { recursive: true, force: true });
  }
}
