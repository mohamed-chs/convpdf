import type GithubSlugger from 'github-slugger';
import type { Vault } from '../vault.ts';

export interface Heading {
  level: number;
  text: string;
  id: string;
}

/** Options that affect how markdown is turned into HTML. */
export interface MarkdownOptions {
  /** Render single newlines as line breaks (Obsidian's default). */
  breaks: boolean;
  /** Shiki theme used for code blocks. */
  codeTheme: string;
  /** Show line numbers in code blocks. */
  lineNumbers: boolean;
  /** Render YAML front matter as a properties table. */
  showFrontmatter: boolean;
  /** Maximum heading level included in the table of contents. */
  tocDepth: number;
}

/**
 * Maps local files to URLs usable from the rendered page. PDF rendering uses
 * file:// URLs; the web preview serves files over HTTP instead.
 */
export interface AssetResolver {
  /** URL for a local file (image, linked file). */
  file(absPath: string): string;
}

/** Shared state for one output document (including all embedded notes). */
export interface RenderContext {
  options: MarkdownOptions;
  resolver: AssetResolver;
  /** Resolves wikilinks and embeds. */
  vault: Vault;
  /** Every local file the output depends on (for watch mode). */
  deps: Set<string>;
  features: { math: boolean; mermaid: boolean };
  warnings: string[];
  /** Headings in document order, collected while rendering. */
  headings: Heading[];
  slugger: GithubSlugger;
  /**
   * Maps a markdown file that is part of this run to an href: an anchor when
   * several files are merged into one PDF, or a relative .pdf link.
   */
  linkTarget?: (absPath: string) => string | null;
  /** Anchor id for the top of the current document (merged mode). */
  docAnchors: Map<string, string>;
  /** Shared KaTeX macro table so \def persists across formulas. */
  katexMacros: Record<string, string>;
  /** Counter used to give each (embedded) document unique footnote ids. */
  docCounter: number;
  /** Add data-line attributes (source line of top-level blocks) for editor scroll sync. */
  sourceLines: boolean;
  /** Added to data-line values (lines taken by front matter). */
  lineOffset: number;
}

/** Per-document markdown-it environment. */
export type RenderEnv = {
  ctx: RenderContext;
  /** Absolute path of the markdown file being rendered, if any. */
  file?: string;
  /** Directory used to resolve relative paths. */
  dir: string;
  /** Unique id prefix used by footnotes. */
  docId: string;
  /** Embed nesting depth; 0 for the top-level document. */
  depth: number;
  /** Files on the current embed chain, for cycle detection. */
  stack: string[];
  /** Footnote plugin state. */
  footnotes?: unknown;
  /** Abbreviation plugin state. */
  abbreviations?: unknown;
};

export function isEnv(env: unknown): env is RenderEnv {
  return !!env && typeof env === 'object' && 'ctx' in env;
}
