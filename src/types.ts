import type { Tokens } from 'marked';

export const PAPER_FORMATS = [
  'Letter',
  'Legal',
  'Tabloid',
  'Ledger',
  'A0',
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6'
] as const;

export type PaperFormat = (typeof PAPER_FORMATS)[number];
export type PaperFormatInput = PaperFormat | Lowercase<PaperFormat>;
export type OutputFormat = 'pdf' | 'html';
export type AssetMode = 'auto' | 'local' | 'cdn';

export interface RendererOptions {
  margin?: string;
  format?: PaperFormatInput;
  toc?: boolean;
  tocDepth?: number;
  customCss?: string | null;
  template?: string | null;
  headerTemplate?: string | null;
  footerTemplate?: string | null;
  basePath?: string;
  baseHref?: string;
  title?: string;
  executablePath?: string;
  maxConcurrentPages?: number;
  linkTargetFormat?: OutputFormat;
  assetMode?: AssetMode;
  assetCacheDir?: string;
  allowNetworkFallback?: boolean;
  mathJaxSrc?: string;
  mermaidSrc?: string;
  mathJaxBaseUrl?: string;
  mathJaxFontBaseUrl?: string;
  onSetupMessage?: (message: string) => void;
}

export interface Frontmatter {
  title?: string;
  toc?: boolean;
  tocDepth?: number;
  [key: string]: unknown;
}

export interface FrontmatterParseResult {
  data: Frontmatter;
  content: string;
  warnings: string[];
}

export interface TocHeading {
  level: number;
  text: string;
  id: string;
}

export type CustomToken = Tokens.Generic & {
  id?: string;
  tokens?: CustomToken[];
  depth?: number;
  text?: string;
};
