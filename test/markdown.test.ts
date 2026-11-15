import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitFrontmatter } from '../src/markdown/frontmatter.ts';
import { html, render } from './helpers.ts';

describe('CommonMark basics', () => {
  it('renders emphasis, code and links', async () => {
    const out = await html('**b** *i* ***bi*** `c` [l](https://x.org "T")');
    assert.match(out, /<strong>b<\/strong>/);
    assert.match(out, /<em>i<\/em>/);
    assert.match(out, /<code>c<\/code>/);
    assert.match(out, /<a href="https:\/\/x.org" title="T">l<\/a>/);
  });

  it('keeps soft breaks by default and converts them with breaks: true', async () => {
    assert.doesNotMatch(await html('a\nb'), /<br>/);
    assert.match(await html('a\nb', { breaks: true }), /a<br>\nb/);
  });

  it('supports hard breaks with two spaces and backslash', async () => {
    const out = await html('a  \nb\\\nc');
    assert.equal((out.match(/<br>/g) ?? []).length, 2);
  });

  it('renders raw HTML and expands <details>', async () => {
    const out = await html('<details>\n<summary>S</summary>\n\nbody\n\n</details>');
    assert.match(out, /<details open>/);
    assert.match(out, /<p>body<\/p>/);
    assert.match(await html('<details open><summary>x</summary></details>'), /<details open><summary>/);
  });
});

describe('GitHub Flavored Markdown', () => {
  it('renders tables with alignment', async () => {
    const out = await html('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |');
    assert.match(out, /<table>/);
    assert.match(out, /<th style="text-align:center">b<\/th>/);
    assert.match(out, /<td style="text-align:right">3<\/td>/);
  });

  it('renders strikethrough', async () => {
    assert.match(await html('~~gone~~'), /<s>gone<\/s>/);
  });

  it('autolinks URLs with a scheme, www. links and emails, but not bare domains', async () => {
    const out = await html('https://a.org www.b.org c@d.org example.com');
    assert.match(out, /<a href="https:\/\/a.org">/);
    assert.match(out, /<a href="http:\/\/www.b.org">www.b.org<\/a>/);
    assert.match(out, /<a href="mailto:c@d.org">/);
    assert.doesNotMatch(out, /href="http:\/\/example.com"/);
  });

  it('renders task lists', async () => {
    const out = await html('- [ ] open\n- [x] done\n- regular');
    assert.match(out, /<ul class="contains-task-list">/);
    assert.match(out, /<li class="task-list-item" data-task=" "><input type="checkbox" class="task-list-item-checkbox" disabled> open/);
    assert.match(out, /data-task="x"><input [^>]*checked> done/);
    assert.match(out, /<li>regular<\/li>/);
  });

  it('supports Obsidian custom task statuses', async () => {
    const out = await html('- [/] half\n- [-] cancelled');
    assert.match(out, /data-task="\/"/);
    assert.match(out, /data-task="-"/);
  });

  it('does not treat [x] without a following space as a task', async () => {
    assert.doesNotMatch(await html('- [x]y'), /checkbox/);
  });

  it('generates GitHub-compatible heading ids, deduplicated', async () => {
    const out = await html('# Hello, World!\n## Hello, World!\n### `code` & Stuff');
    assert.match(out, /<h1 id="hello-world">/);
    assert.match(out, /<h2 id="hello-world-1">/);
    assert.match(out, /<h3 id="code--stuff">/);
  });

  it('renders footnotes with unique ids', async () => {
    const out = await html('Text[^a] more^[inline note].\n\n[^a]: The note.');
    assert.match(out, /<sup class="footnote-ref"><a href="#fn-d\d+-1" id="fnref-d\d+-1">1<\/a><\/sup>/);
    assert.match(out, /<section class="footnotes">/);
    assert.match(out, /inline note/);
    assert.doesNotMatch(out, /footnotes-sep/);
  });

  it('converts emoji shortcodes but not emoticons or unknown codes', async () => {
    const out = await html(':tada: :) :not_an_emoji: 10:30:00');
    assert.match(out, /🎉/);
    assert.match(out, /:\)/);
    assert.match(out, /:not_an_emoji:/);
    assert.match(out, /10:30:00/);
  });

  it('renders all five alert types with titles', async () => {
    for (const type of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
      const out = await html(`> [!${type}]\n> Body text`);
      assert.match(out, new RegExp(`<div class="callout" data-callout="${type.toLowerCase()}"`));
      const title = type.charAt(0) + type.slice(1).toLowerCase();
      assert.match(out, new RegExp(`<span class="callout-title-inner">${title}</span>`));
      assert.match(out, /<div class="callout-content">\n<p>Body text<\/p>/);
    }
  });
});

describe('Callouts', () => {
  it('supports custom titles with inline markdown', async () => {
    const out = await html('> [!tip] A *fancy* title\n> body');
    assert.match(out, /<span class="callout-title-inner">A <em>fancy<\/em> title<\/span>/);
  });

  it('supports title-only callouts', async () => {
    const out = await html('> [!success] Done');
    assert.match(out, /callout-title-inner">Done</);
    assert.doesNotMatch(out, /callout-content/);
  });

  it('records fold state and metadata', async () => {
    const out = await html('> [!faq|wide]- Question?\n> Answer');
    assert.match(out, /data-callout="faq" data-color="question" data-callout-metadata="wide" data-callout-fold="-"/);
  });

  it('maps aliases to their canonical colour', async () => {
    assert.match(await html('> [!tldr]\n> x'), /data-color="abstract"/);
    assert.match(await html('> [!error]\n> x'), /data-color="danger"/);
    assert.match(await html('> [!custom-type]\n> x'), /data-callout="custom-type" data-color="note"[\s\S]*Custom type/);
  });

  it('supports nested callouts and multiple blocks', async () => {
    const out = await html('> [!note] Outer\n> para 1\n>\n> - list\n>\n> > [!warning] Inner\n> > inner body');
    assert.equal((out.match(/class="callout"/g) ?? []).length, 2);
    assert.match(out, /<li>list<\/li>/);
    // well-formed: equal number of opening and closing divs
    assert.equal((out.match(/<div/g) ?? []).length, (out.match(/<\/div>/g) ?? []).length);
  });

  it('leaves ordinary blockquotes alone', async () => {
    const out = await html('> just a quote\n> [!note] not first line');
    assert.match(out, /<blockquote>/);
    assert.doesNotMatch(out, /callout/);
  });
});

describe('Math', () => {
  it('renders inline math', async () => {
    const out = await html('Euler: $e^{i\\pi}+1=0$.');
    assert.match(out, /<span class="katex">/);
    assert.doesNotMatch(out, /\$/);
  });

  it('renders GitHub $`...`$ inline math', async () => {
    assert.match(await html('Root $`\\sqrt{2}`$ here'), /class="katex"/);
  });

  it('does not treat prices as math', async () => {
    const out = await html('It costs $5 and $10 total. Also $ x$ and $x $.');
    assert.doesNotMatch(out, /katex/);
  });

  it('respects escaped dollars', async () => {
    assert.doesNotMatch(await html('\\$x$ and $y\\$'), /katex/);
  });

  it('renders display math blocks (multi-line and single-line)', async () => {
    const multi = await html('$$\na^2 + b^2 = c^2\n$$');
    assert.match(multi, /<div class="math-block"><span class="katex-display">/);
    const single = await html('$$ x = 1 $$');
    assert.match(single, /class="math-block"/);
  });

  it('renders ```math fences', async () => {
    assert.match(await html('```math\n\\frac{1}{2}\n```'), /class="math-block"[\s\S]*katex-display/);
  });

  it('renders math inside lists and callouts', async () => {
    const out = await html('- item\n  $$\n  x^2\n  $$\n\n> [!note]\n> $$\n> y\n> $$');
    assert.equal((out.match(/class="math-block"/g) ?? []).length, 2);
  });

  it('shows invalid TeX as an error instead of failing', async () => {
    assert.match(await html('$\\frac{1}{$'), /class="math-error"/);
  });

  it('supports mhchem', async () => {
    assert.match(await html('$\\ce{H2O}$'), /class="katex"/);
  });

  it('keeps \\def macros across formulas', async () => {
    const out = await html('$\\def\\R{\\mathbb{R}}$ then $\\R$');
    assert.doesNotMatch(out, /math-error/);
    assert.match(out, /mathbb/);
  });

  it('marks the document as needing math styles', async () => {
    const { ctx } = await render('$x$');
    assert.equal(ctx.features.math, true);
    const plain = await render('no math');
    assert.equal(plain.ctx.features.math, false);
  });
});

describe('Code', () => {
  it('highlights known languages with inline colours', async () => {
    const out = await html('```js\nconst x = 1;\n```');
    assert.match(out, /<div class="code-block"><pre data-lang="js"><code><span class="line"><span style="color:#[0-9A-F]{6}">const<\/span>/i);
  });

  it('renders unknown languages as plain lines', async () => {
    const out = await html('```nosuchlang\na < b\n```');
    assert.match(out, /<span class="line">a &lt; b<\/span>/);
  });

  it('supports code titles', async () => {
    assert.match(await html('```ts title="file.ts"\nx\n```'), /<div class="code-title">file.ts<\/div>/);
  });

  it('marks added and removed diff lines', async () => {
    const out = await html('```diff\n- old\n+ new\n  same\n```');
    assert.match(out, /class="line diff-remove"/);
    assert.match(out, /class="line diff-add"/);
  });

  it('adds line numbers when enabled', async () => {
    assert.match(await html('```\nx\n```', { lineNumbers: true }), /class="code-block line-numbers"/);
  });

  it('renders indented code blocks', async () => {
    assert.match(await html('    indented'), /<pre><code><span class="line">indented<\/span>/);
  });

  it('turns mermaid fences into diagram placeholders', async () => {
    const { html: out, ctx } = await render('```mermaid\ngraph TD; A-->B\n```');
    assert.match(out, /<div class="mermaid-diagram"><pre class="mermaid">graph TD; A--&gt;B\n<\/pre><\/div>/);
    assert.equal(ctx.features.mermaid, true);
  });
});

describe('Extras', () => {
  it('renders ==highlights==', async () => {
    assert.match(await html('a ==marked== b'), /<mark>marked<\/mark>/);
  });

  it('renders definition lists', async () => {
    assert.match(await html('Term\n: Definition'), /<dl>\n<dt>Term<\/dt>\n<dd>Definition<\/dd>/);
  });

  it('renders abbreviations', async () => {
    assert.match(await html('*[HTML]: Hyper Text\n\nHTML rocks'), /<abbr title="Hyper Text">HTML<\/abbr>/);
  });

  it('inserts a table of contents at [TOC] markers', async () => {
    const out = await html('[TOC]\n\n# One\n## Two\n#### Too deep');
    assert.match(out, /<nav class="toc">/);
    assert.match(out, /<a href="#one"><span class="toc-text">One<\/span>/);
    assert.match(out, /<a href="#two">/);
    assert.doesNotMatch(out, /too-deep"><span/);
    for (const marker of ['[[_TOC_]]', '${toc}', '[[toc]]']) {
      assert.match(await html(`${marker}\n\n# A`), /<nav class="toc">/, marker);
    }
  });

  it('renders page breaks', async () => {
    for (const marker of ['\\pagebreak', '\\newpage', '<!-- pagebreak -->']) {
      assert.match(await html(`a\n\n${marker}\n\nb`), /<div class="page-break"><\/div>/, marker);
    }
  });

  it('marks image-only paragraphs', async () => {
    assert.match(await html('![x](pixel.png)'), /<p class="image-paragraph"><img/);
    assert.doesNotMatch(await html('text ![x](pixel.png)'), /image-paragraph/);
  });
});

describe('Links and images', () => {
  it('resolves relative images to file URLs', async () => {
    const out = await html('![pixel](pixel.png)');
    assert.match(out, /<img src="file:\/\/[^"]*fixtures\/plain\/pixel.png" alt="pixel">/);
  });

  it('supports Obsidian image sizes in alt text', async () => {
    assert.match(await html('![alt|100x50](pixel.png)'), /alt="alt" width="100" height="50"/);
  });

  it('warns about missing images', async () => {
    const { ctx } = await render('![x](missing.png)');
    assert.match(ctx.warnings.join('\n'), /Image not found: missing.png/);
  });

  it('leaves remote images and data URIs untouched', async () => {
    assert.match(await html('![x](https://example.com/a.png)'), /src="https:\/\/example.com\/a.png"/);
  });

  it('rewrites relative src attributes in raw HTML', async () => {
    assert.match(await html('<img src="pixel.png" width="20">'), /<img src="file:\/\/[^"]*pixel.png" width="20">/);
  });

  it('maps links to other converted markdown files', async () => {
    const { html: out } = await render('[B](b.md) [S](b.md#section-b) [ext](https://x.org)', {
      linkTarget: (p) => (p.endsWith('b.md') ? 'b.pdf' : null),
    });
    assert.match(out, /href="b.pdf"/);
    assert.match(out, /href="b.pdf#section-b"/);
    assert.match(out, /href="https:\/\/x.org"/);
  });

  it('allows file: links but not javascript: links', async () => {
    assert.match(await html('[f](file:///etc/hosts)'), /href="file:\/\/\/etc\/hosts"/);
    assert.doesNotMatch(await html('[j](javascript:alert(1))'), /href="javascript/);
  });
});

describe('Front matter', () => {
  it('splits YAML front matter', () => {
    const { raw, body } = splitFrontmatter('---\ntitle: x\n---\n# Body');
    assert.equal(raw, 'title: x');
    assert.equal(body, '# Body');
  });

  it('handles empty front matter and BOMs', () => {
    assert.equal(splitFrontmatter('﻿---\n---\ntext').body, 'text');
  });

  it('does not mistake a thematic break + setext heading for front matter', () => {
    const src = '---\nSome text\n---\nmore';
    assert.equal(splitFrontmatter(src).raw, null);
  });
});
