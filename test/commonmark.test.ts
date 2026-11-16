/**
 * The CommonMark spec examples, parsed with every convpdf plugin enabled.
 *
 * Rendering uses markdown-it's default renderer, so this checks that our
 * syntax extensions don't change how standard Markdown parses. The few
 * expected differences are listed below with the reason.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import MarkdownIt from 'markdown-it';
import { createContext, getMarkdown, renderMarkdown } from '../src/markdown/index.ts';
import { Vault } from '../src/vault.ts';
import { FIXTURES, MD_DEFAULTS } from './helpers.ts';

interface SpecExample {
  markdown: string;
  html: string;
  section: string;
  number: number;
}

const require = createRequire(import.meta.url);
const spec = require('commonmark-spec') as { tests: SpecExample[] };

const EXPECTED_DIFFERENCES: Record<number, string> = {
  64: 'Obsidian tag (#hashtag)',
  218: 'markdown-it renders an empty blockquote on one line',
  239: 'markdown-it renders an empty blockquote on one line',
  240: 'markdown-it renders an empty blockquote on one line',
  548: 'Obsidian wikilink ([[foo]])',
  559: 'Obsidian wikilink ([[*foo* bar]])',
  590: 'Obsidian embed (![[foo]])',
  602: 'GFM autolink extension',
  608: 'GFM autolink extension',
  611: 'GFM autolink extension',
  612: 'GFM autolink extension',
};

describe('CommonMark spec', () => {
  it('parses every example as CommonMark does, apart from GFM/Obsidian extensions', async () => {
    const md = getMarkdown();
    const plain = new MarkdownIt('commonmark');
    const original = md.renderer.render;
    md.renderer.render = (...[tokens, options, env]: Parameters<typeof original>) =>
      plain.renderer.render(tokens, { ...options, xhtmlOut: true, langPrefix: 'language-' }, env);
    const dir = join(FIXTURES, 'plain');
    const failures: string[] = [];
    try {
      for (const example of spec.tests) {
        if (EXPECTED_DIFFERENCES[example.number]) continue;
        const source = example.markdown.replace(/→/g, '\t');
        const expected = example.html.replace(/→/g, '\t');
        const ctx = createContext({ options: MD_DEFAULTS, resolver: { file: (p) => p }, vault: Vault.for(dir, false) });
        const { html } = await renderMarkdown(source, ctx, undefined, dir);
        // Paragraphs holding only an image get a class for centring.
        const actual = html.replaceAll(' class="image-paragraph"', '');
        if (actual !== expected) failures.push(`#${example.number} (${example.section}): ${JSON.stringify(source)}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
      }
    } finally {
      md.renderer.render = original;
    }
    assert.equal(failures.length, 0, failures.join('\n'));
  });
});
