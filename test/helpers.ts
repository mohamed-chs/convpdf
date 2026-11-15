import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, renderMarkdown } from '../src/markdown/index.ts';
import type { MarkdownOptions, RenderContext } from '../src/markdown/types.ts';
import { Vault } from '../src/vault.ts';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const MD_DEFAULTS: MarkdownOptions = {
  breaks: false,
  codeTheme: 'github-light',
  lineNumbers: false,
  showFrontmatter: false,
  tocDepth: 3,
};

export interface RenderResult {
  html: string;
  ctx: RenderContext;
}

/** Render markdown as if it were the file `file` (default: an in-memory doc in fixtures/plain). */
export async function render(
  source: string,
  opts: { file?: string; options?: Partial<MarkdownOptions>; linkTarget?: (p: string) => string | null } = {},
): Promise<RenderResult> {
  const file = opts.file;
  const dir = file ? dirname(file) : join(FIXTURES, 'plain');
  const ctx = createContext({
    options: { ...MD_DEFAULTS, ...opts.options },
    resolver: { file: (p) => `file://${p}` },
    vault: Vault.for(dir, true),
    linkTarget: opts.linkTarget,
  });
  const { html } = await renderMarkdown(source, ctx, file, dir);
  return { html, ctx };
}

export async function html(source: string, options?: Partial<MarkdownOptions>): Promise<string> {
  return (await render(source, { options })).html;
}
