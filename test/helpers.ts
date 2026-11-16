import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, renderMarkdown, resolveHeadingRefs } from '../src/markdown/index.ts';
import type { MarkdownOptions, RenderContext } from '../src/markdown/types.ts';
import { Vault } from '../src/vault.ts';

// Keep tests away from the user's diagram cache, and from each other's results.
if (!process.env['MDPDF_CACHE_DIR']) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'mdpdf-cache-'));
  process.env['MDPDF_CACHE_DIR'] = cacheDir;
  process.on('exit', () => rmSync(cacheDir, { recursive: true, force: true }));
}

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
  return { html: resolveHeadingRefs(html, ctx), ctx };
}

export async function html(source: string, options?: Partial<MarkdownOptions>): Promise<string> {
  return (await render(source, { options })).html;
}
