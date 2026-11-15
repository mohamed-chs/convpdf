/**
 * Conversion options: defaults, validation and merging from the different
 * sources (defaults < config file < front matter < command line).
 */
import type { MarkdownOptions } from './markdown/types.ts';

export interface ConvertOptions extends MarkdownOptions {
  /** Built-in theme name or path to a CSS file. */
  theme: string;
  /** Extra stylesheets applied after the theme. */
  css: string[];
  /** Paper size: A4, Letter, Legal, A3, A5, ... or "210mm 297mm". */
  paper: string;
  landscape: boolean;
  /** CSS margin shorthand for the page, e.g. "20mm" or "1in 0.75in". */
  margin: string;
  /** Insert a table of contents at the start. */
  toc: boolean;
  tocTitle: string;
  /** Fill in page numbers in tables of contents (needs a second print pass). */
  tocPageNumbers: boolean;
  /** Footer/header templates: "left|center|right" with {page} {pages} {title} {author} {date} {file}. */
  header: string;
  footer: string;
  /** Base font size, e.g. "10.5pt" (theme default when empty). */
  fontSize: string;
  /** Start every heading of this level on a new page. */
  breakBefore: 'none' | 'h1' | 'h2';
  /** Show a title block built from front matter title/author/date. */
  titleBlock: boolean;
  mermaidTheme: string;
  /** Document metadata. */
  title: string;
  author: string;
  subject: string;
  keywords: string[];
  date: string;
  lang: string;
  /** Milliseconds to wait for a document (images, diagrams) to render. */
  timeout: number;
}

const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'PR', 'GT', 'CR', 'PA', 'DO', 'SV', 'NI', 'BZ']);

/** Letter in the Americas (and the Philippines), A4 everywhere else. */
export function defaultPaper(): string {
  const envLocale = process.env['LC_PAPER'] || process.env['LC_ALL'] || process.env['LANG'] || '';
  let region = /^[a-z]{2,3}[_-]([A-Z]{2})/i.exec(envLocale)?.[1]?.toUpperCase();
  if (!region) {
    try {
      region = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).maximize().region;
    } catch {
      region = undefined;
    }
  }
  return region && LETTER_REGIONS.has(region) ? 'Letter' : 'A4';
}

export function defaultOptions(): ConvertOptions {
  return {
    breaks: false,
    codeTheme: 'github-light',
    lineNumbers: false,
    showFrontmatter: false,
    tocDepth: 3,
    theme: 'default',
    css: [],
    paper: defaultPaper(),
    landscape: false,
    margin: '18mm 18mm 20mm',
    toc: false,
    tocTitle: 'Contents',
    tocPageNumbers: true,
    header: '',
    footer: '{page} / {pages}',
    fontSize: '',
    breakBefore: 'none',
    titleBlock: true,
    mermaidTheme: 'auto',
    title: '',
    author: '',
    subject: '',
    keywords: [],
    date: '',
    lang: 'en',
    timeout: 30_000,
  };
}

type Kind = 'string' | 'boolean' | 'number' | 'string[]';

export const OPTION_KINDS: Record<keyof ConvertOptions, Kind> = {
  breaks: 'boolean',
  codeTheme: 'string',
  lineNumbers: 'boolean',
  showFrontmatter: 'boolean',
  tocDepth: 'number',
  theme: 'string',
  css: 'string[]',
  paper: 'string',
  landscape: 'boolean',
  margin: 'string',
  toc: 'boolean',
  tocTitle: 'string',
  tocPageNumbers: 'boolean',
  header: 'string',
  footer: 'string',
  fontSize: 'string',
  breakBefore: 'string',
  titleBlock: 'boolean',
  mermaidTheme: 'string',
  title: 'string',
  author: 'string',
  subject: 'string',
  keywords: 'string[]',
  date: 'string',
  lang: 'string',
  timeout: 'number',
};

/** Accept a few friendly aliases in config files and front matter. */
const ALIASES: Record<string, keyof ConvertOptions> = {
  format: 'paper',
  pageSize: 'paper',
  'page-size': 'paper',
  size: 'paper',
  orientation: 'landscape',
  'line-numbers': 'lineNumbers',
  'code-theme': 'codeTheme',
  'toc-depth': 'tocDepth',
  'toc-title': 'tocTitle',
  'font-size': 'fontSize',
  'break-before': 'breakBefore',
  pageBreak: 'breakBefore',
  'mermaid-theme': 'mermaidTheme',
  'title-block': 'titleBlock',
  'show-frontmatter': 'showFrontmatter',
  language: 'lang',
  tags: 'keywords',
};

function toDateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/**
 * Validate and coerce untrusted option values (from YAML/JSON). Unknown keys
 * are reported through `warn` and ignored.
 */
export function coerceOptions(input: Record<string, unknown>, warn: (msg: string) => void, source: string): Partial<ConvertOptions> {
  const out: Partial<ConvertOptions> = {};
  const target = out as Record<string, unknown>;
  for (const [rawKey, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const key = (ALIASES[rawKey] ?? rawKey) as keyof ConvertOptions;
    const kind = OPTION_KINDS[key];
    if (!kind) {
      warn(`Unknown option "${rawKey}" in ${source}`);
      continue;
    }
    if (key === 'landscape' && typeof value === 'string') {
      target[key] = value.toLowerCase() === 'landscape';
      continue;
    }
    switch (kind) {
      case 'boolean':
        if (typeof value === 'boolean') target[key] = value;
        else if (value === 'true' || value === 'false') target[key] = value === 'true';
        else warn(`Option "${rawKey}" in ${source} should be true or false`);
        break;
      case 'number': {
        const n = Number(value);
        if (Number.isFinite(n)) target[key] = n;
        else warn(`Option "${rawKey}" in ${source} should be a number`);
        break;
      }
      case 'string[]':
        target[key] = Array.isArray(value) ? value.map(String) : String(value).split(',').map((s) => s.trim()).filter(Boolean);
        break;
      default:
        target[key] = key === 'date' ? toDateString(value) : String(value);
    }
  }
  if (out.breakBefore && !['none', 'h1', 'h2'].includes(out.breakBefore)) {
    warn(`Option "breakBefore" in ${source} must be none, h1 or h2`);
    delete out.breakBefore;
  }
  return out;
}

export function mergeOptions(...layers: Array<Partial<ConvertOptions> | undefined>): ConvertOptions {
  const result = defaultOptions();
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue;
      if (k === 'css' && Array.isArray(v)) {
        result.css = [...result.css, ...v];
        continue;
      }
      (result as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return result;
}
