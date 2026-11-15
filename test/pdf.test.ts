/**
 * End-to-end tests: markdown → PDF through a real headless Chrome.
 * Skipped when no Chrome/Chromium is installed. Text checks use poppler's
 * pdftotext/pdfinfo when available.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Converter, type JobResult } from '../src/convert.ts';
import { findChrome } from '../src/pdf/chrome.ts';
import { destinationPages } from '../src/pdf/postprocess.ts';
import { FIXTURES } from './helpers.ts';

function hasChrome(): boolean {
  try {
    findChrome();
    return true;
  } catch {
    return false;
  }
}

function hasTool(name: string): boolean {
  try {
    execFileSync(name, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skip = hasChrome() ? false : 'Chrome not found';
const poppler = hasTool('pdftotext') && hasTool('pdfinfo');

function pdfText(bytes: Buffer): string {
  return execFileSync('pdftotext', ['-layout', '-', '-'], { input: bytes }).toString();
}

function pdfInfo(bytes: Buffer): Record<string, string> {
  const out = execFileSync('pdfinfo', ['-'], { input: bytes }).toString();
  return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i), l.slice(i + 1).trim()];
  }));
}

describe('PDF output', { skip }, () => {
  let converter: Converter;
  let dir: string;

  before(() => {
    converter = new Converter({ cli: { paper: 'A4' } });
    dir = mkdtempSync(join(tmpdir(), 'mdpdf-test-'));
  });
  after(async () => {
    await converter.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const pdf = (source: string, file?: string): Promise<JobResult> =>
    converter.convert({ inputs: [{ source, file }], output: null, format: 'pdf' });

  it('produces a valid PDF with metadata from front matter', async () => {
    const result = await pdf('---\ntitle: Hello Test\nauthor: Ada\ntags: [x, y]\n---\n# Heading\n\nSome text.');
    assert.equal(result.bytes.subarray(0, 5).toString(), '%PDF-');
    assert.equal(result.pages, 1);
    assert.deepEqual(result.warnings, []);
    if (poppler) {
      const info = pdfInfo(result.bytes);
      assert.equal(info['Title'], 'Hello Test');
      assert.equal(info['Author'], 'Ada');
      assert.equal(info['Keywords'], 'x, y');
      assert.match(info['Creator']!, /^mdpdf /);
      assert.equal(info['Tagged'], 'yes');
      assert.match(info['Page size']!, /^594.96 x 841.92/);
    }
  });

  it('uses the first heading as title when there is no front matter', async () => {
    const result = await pdf('# The Real Title\n\ntext');
    if (poppler) assert.equal(pdfInfo(result.bytes)['Title'], 'The Real Title');
  });

  it('takes page options from front matter, with the command line winning', async () => {
    // The converter was created with `paper: A4` on the "command line".
    const result = await pdf('---\npdf:\n  paper: Letter\n  landscape: true\n---\ntext');
    if (poppler) assert.match(pdfInfo(result.bytes)['Page size']!, /^841.92 x 594.96/);
    const c = new Converter();
    try {
      const letter = await c.convert({ inputs: [{ source: '---\npaper: Letter\n---\ntext' }], output: null, format: 'pdf' });
      if (poppler) assert.match(pdfInfo(letter.bytes)['Page size']!, /^612 x 792/);
    } finally {
      await c.close();
    }
  });

  it('renders page numbers in the footer', { skip: !poppler && 'poppler missing' }, async () => {
    const result = await pdf('page one\n\n\\pagebreak\n\npage two');
    assert.equal(result.pages, 2);
    const text = pdfText(result.bytes);
    assert.match(text, /\b1\s*\/\s*2\b/);
    assert.match(text, /\b2\s*\/\s*2\b/);
  });

  it('renders custom headers with template variables', { skip: !poppler && 'poppler missing' }, async () => {
    const result = await pdf('---\ntitle: Report\npdf:\n  header: "{title}||{date}"\n  date: 2026-01-02\n  footer: ""\n---\nbody');
    const text = pdfText(result.bytes);
    assert.match(text, /Report\s+2026-01-02/);
    assert.doesNotMatch(text, /1 \/ 1/);
  });

  it('fills in table of contents page numbers', async () => {
    const result = await pdf('---\npdf:\n  toc: true\n---\n# First\n\n\\pagebreak\n\n# Second\n\n\\pagebreak\n\n## Third');
    const dests = destinationPages(result.bytes);
    // The table of contents gets a page of its own.
    assert.equal(dests.get('first'), 2);
    assert.equal(dests.get('second'), 3);
    assert.equal(result.pages, 4);
    if (poppler) {
      const text = pdfText(result.bytes);
      assert.match(text, /Contents/);
      assert.match(text, /First\s+2\n/);
      assert.match(text, /Second\s+3\n/);
      assert.match(text, /Third\s+4\n/);
    }
  });

  it('renders math, code, callouts and mermaid without warnings', async () => {
    const source = [
      '> [!warning] Careful',
      '> Body',
      '',
      '$$\\int_0^1 x\\,dx = \\tfrac12$$',
      '',
      '```python',
      'def f(): return 42',
      '```',
      '',
      '```mermaid',
      'graph LR; A[Start]-->B[Finish]',
      '```',
    ].join('\n');
    const result = await pdf(source);
    assert.deepEqual(result.warnings, []);
    if (poppler) {
      const text = pdfText(result.bytes);
      assert.match(text, /Careful/);
      assert.match(text, /def f\(\): return 42/);
      assert.match(text, /Start/);
      assert.match(text, /Finish/);
    }
  });

  it('reports invalid mermaid diagrams as warnings and still produces a PDF', async () => {
    const result = await pdf('```mermaid\ngraph TD; A-->\n```');
    assert.equal(result.pages, 1);
    assert.match(result.warnings.join('\n'), /[Mm]ermaid/);
  });

  it('embeds only static (non Type 3) fonts', { skip: !hasTool('pdffonts') && 'pdffonts missing' }, async () => {
    const result = await pdf('# Title\n\nText with **bold**, *italic* and `code`.\n\n- [x] done ✓');
    const fonts = execFileSync('pdffonts', ['-'], { input: result.bytes }).toString();
    assert.doesNotMatch(fonts, /Type 3/);
    assert.match(fonts, /Inter/);
    assert.match(fonts, /JetBrainsMono/);
  });

  it('merges several files into one PDF with working cross-links', async () => {
    const a = join(FIXTURES, 'plain', 'a.md');
    const b = join(FIXTURES, 'plain', 'b.md');
    const output = join(dir, 'merged.pdf');
    const result = await converter.convert({ inputs: [{ file: a }, { file: b }], output, format: 'pdf' });
    assert.ok(result.pages >= 2);
    assert.ok(readFileSync(output).equals(result.bytes));
    const dests = destinationPages(result.bytes);
    assert.ok(dests.has('doc-2') || dests.has('section-b'), `destinations: ${[...dests.keys()]}`);
    assert.ok(result.deps.has(a) && result.deps.has(b));
  });

  it('converts an Obsidian note with embeds and images', async () => {
    const home = join(FIXTURES, 'vault', 'Home.md');
    const result = await converter.convert({ inputs: [{ file: home }], output: null, format: 'pdf' });
    assert.deepEqual(result.warnings, []);
    if (poppler) {
      const text = pdfText(result.bytes);
      assert.match(text, /Ship it/);
    }
  });

  it('exports standalone HTML', async () => {
    const result = await converter.convert({ inputs: [{ source: '# Hi\n\n$x$' }], output: null, format: 'html' });
    const html = result.bytes.toString();
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<h1 id="hi">Hi<\/h1>/);
    assert.match(html, /katex/);
  });

  it('converts many documents concurrently', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => pdf(`# Doc ${i}\n\n${'Paragraph. '.repeat(50)}`)),
    );
    for (const r of results) assert.equal(r.bytes.subarray(0, 5).toString(), '%PDF-');
    if (poppler) results.forEach((r, i) => assert.match(pdfText(r.bytes), new RegExp(`Doc ${i}`)));
  });

  it('applies user CSS files', async () => {
    const css = join(dir, 'custom.css');
    writeFileSync(css, 'h1 { display: none; }');
    const c = new Converter({ cli: { css: [css] } });
    try {
      const result = await c.convert({ inputs: [{ source: '# Hidden Heading\n\nvisible' }], output: null, format: 'pdf' });
      if (poppler) {
        const text = pdfText(result.bytes);
        assert.doesNotMatch(text, /Hidden Heading/);
        assert.match(text, /visible/);
      }
    } finally {
      await c.close();
    }
  });
});
