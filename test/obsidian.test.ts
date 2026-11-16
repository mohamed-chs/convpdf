import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Converter } from '../src/convert.ts';
import { parseWikiTarget } from '../src/markdown/plugins/obsidian.ts';
import { Vault } from '../src/vault.ts';
import { FIXTURES, html, render } from './helpers.ts';

const VAULT = join(FIXTURES, 'vault');
const HOME = join(VAULT, 'Home.md');

describe('wikilink parsing', () => {
  it('splits path, heading and alias', () => {
    assert.deepEqual(parseWikiTarget('Note#Heading|Alias'), { path: 'Note', subpath: 'Heading', alias: 'Alias' });
    assert.deepEqual(parseWikiTarget('#^block'), { path: '', subpath: '^block', alias: null });
    assert.deepEqual(parseWikiTarget('a/b#H1#H2'), { path: 'a/b', subpath: 'H2', alias: null });
    assert.deepEqual(parseWikiTarget('Note\\|Alias'), { path: 'Note', subpath: '', alias: 'Alias' });
  });
});

describe('vault resolution', () => {
  const vault = Vault.for(HOME);

  it('detects the Obsidian vault and its settings', () => {
    assert.equal(vault.isObsidian, true);
    assert.equal(vault.root, VAULT);
    assert.equal(vault.config.strictLineBreaks, false);
  });

  it('resolves notes by name anywhere in the vault', () => {
    assert.equal(vault.resolveLink('Project Plan', VAULT), join(VAULT, 'notes', 'Project Plan.md'));
    assert.equal(vault.resolveLink('project plan', VAULT), join(VAULT, 'notes', 'Project Plan.md'));
    assert.equal(vault.resolveLink('notes/Project Plan', VAULT), join(VAULT, 'notes', 'Project Plan.md'));
    assert.equal(vault.resolveLink('pixel.png', VAULT), join(VAULT, 'attachments', 'pixel.png'));
    assert.equal(vault.resolveLink('Nowhere', VAULT), null);
  });

  it('resolves vault-root-relative paths and bare file names for markdown images', () => {
    assert.equal(vault.resolvePath('attachments/pixel.png', join(VAULT, 'notes')), join(VAULT, 'attachments', 'pixel.png'));
    assert.equal(vault.resolvePath('pixel.png', join(VAULT, 'notes')), join(VAULT, 'attachments', 'pixel.png'));
  });
});

describe('heading links', () => {
  it('accepts GitHub-style, Obsidian-style and nested heading fragments', async () => {
    const out = await html(
      '[a](#Some%20Heading) [b](#some-heading) [c](<#Some Heading>) [[#Top#Sub Part]] [d](#custom) [e](#nothing-here)\n\n' +
        '# Top\n\n## Some Heading\n\n### Sub Part\n\n<a id="custom"></a>',
    );
    assert.match(out, /href="#some-heading">a</);
    assert.match(out, /href="#some-heading">b</);
    assert.match(out, /href="#some-heading">c</);
    assert.match(out, /href="#sub-part">/);
    assert.match(out, /href="#custom">d</);
    assert.match(out, /href="#nothing-here">e</, 'unknown fragments are left alone');
  });

  it('keeps explicit ids of repeated headings', async () => {
    const out = await html('[second](#dup-1)\n\n## Dup\n\n## Dup');
    assert.match(out, /href="#dup-1">second</);
  });

  it('resolves links between merged notes to the right (deduplicated) heading', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'convpdf-refs-'));
    try {
      writeFileSync(join(dir, 'A.md'), '# A\n\n## Setup\n\n[[B#Setup]] [b](B.md#Setup) [own](#Setup) [[B#^blk]] [blk](B.md#^blk)\n\n![[B#Setup]]\n');
      writeFileSync(join(dir, 'B.md'), '# B\n\n## Setup\n\nB setup. ^blk\n');
      const converter = new Converter();
      const { html: doc } = await converter.renderHtml({ inputs: [{ file: join(dir, 'A.md') }, { file: join(dir, 'B.md') }], output: null, format: 'pdf' });
      await converter.close();
      const ids = [...doc.matchAll(/<h2 id="([^"]+)">Setup/g)].map((m) => m[1]);
      assert.deepEqual(ids, ['setup', 'setup-1', 'setup-2']); // A, the embed of B in A, B itself
      // Links into B go to B's own section, not the embedded copy or A's heading.
      assert.match(doc, /<a class="internal-link" href="#setup-2">B › Setup<\/a>/);
      assert.match(doc, /<a href="#setup-2">b<\/a>/);
      assert.match(doc, /<a href="#setup">own<\/a>/);
      assert.match(doc, /<a class="internal-link" href="#\^blk">B › blk<\/a>/);
      assert.match(doc, /<a href="#\^blk">blk<\/a>/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('wikilinks', () => {
  it('renders resolved, aliased and unresolved links', async () => {
    const { html: out } = await render('[[Project Plan]] [[Project Plan|alias]] [[Nowhere]]', { file: HOME });
    assert.match(out, /<span class="internal-link">Project Plan<\/span>/);
    assert.match(out, /<span class="internal-link">alias<\/span>/);
    assert.match(out, /<span class="internal-link is-unresolved">Nowhere<\/span>/);
  });

  it('links to headings and blocks in the same note', async () => {
    const out = await html('[[#My Heading]] [[#^abc]]');
    assert.match(out, /<a class="internal-link" href="#my-heading">My Heading<\/a>/);
    assert.match(out, /<a class="internal-link" href="#\^abc">abc<\/a>/);
  });

  it('links to other notes that are part of the same output', async () => {
    const { html: out } = await render('[[Project Plan]] [[Project Plan#Goals|goals]]', {
      file: HOME,
      linkTarget: (p) => (p.endsWith('Project Plan.md') ? '#doc-2' : null),
    });
    assert.match(out, /<a class="internal-link" href="#doc-2">Project Plan<\/a>/);
    // The target isn't rendered here, so the heading link falls back to the note's start.
    assert.match(out, /<a class="internal-link" href="#doc-2">goals<\/a>/);
  });

  it('shows "Note › Heading" for heading links without alias', async () => {
    const { html: out } = await render('[[Project Plan#Goals]]', { file: HOME });
    assert.match(out, /Project Plan › Goals/);
  });

  it('works inside tables with escaped pipes', async () => {
    const { html: out } = await render('| a |\n|---|\n| [[Project Plan\\|plan]] |', { file: HOME });
    assert.match(out, /<td><span class="internal-link">plan<\/span><\/td>/);
  });
});

describe('embeds', () => {
  it('embeds images with sizes', async () => {
    const { html: out } = await render('![[pixel.png|50]]', { file: HOME });
    assert.match(out, /<p class="image-paragraph"><img src="file:\/\/[^"]*attachments\/pixel.png" alt="pixel.png" width="50" class="embed-image"><\/p>/);
  });

  it('embeds a section of another note', async () => {
    const { html: out, ctx } = await render('![[Project Plan#Goals]]', { file: HOME });
    assert.match(out, /<div class="markdown-embed" data-embed="Project Plan#Goals">/);
    assert.match(out, /<h2 id="goals">Goals<\/h2>/);
    assert.match(out, /Ship it/);
    assert.doesNotMatch(out, /Risks/);
    assert.doesNotMatch(out, /Intro paragraph/);
    assert.ok([...ctx.deps].some((d) => d.endsWith('Project Plan.md')));
  });

  it('embeds a whole note without its front matter', async () => {
    const { html: out } = await render('![[Project Plan]]', { file: HOME });
    assert.match(out, /Intro paragraph/);
    assert.match(out, /Risks/);
    assert.doesNotMatch(out, /status: draft/);
  });

  it('embeds a block by id', async () => {
    const { html: out } = await render('![[Project Plan#^risk-1]]', { file: HOME });
    assert.match(out, /<p id="\^risk-1">Something risky.<\/p>/);
    assert.doesNotMatch(out, /Goals/);
  });

  it('embeds a list item by id', async () => {
    const { html: out } = await render('![[Project Plan#^goal-ship]]', { file: HOME });
    assert.match(out, /Ship it/);
    assert.doesNotMatch(out, /Test it/);
  });

  it('reports missing embeds', async () => {
    const { html: out, ctx } = await render('![[Nope]]', { file: HOME });
    assert.match(out, /<span class="embed-missing">Nope<\/span>/);
    assert.match(ctx.warnings.join(), /Embedded file not found: Nope/);
  });

  it('stops recursive embeds', async () => {
    const loop = join(VAULT, 'notes', 'Loop.md');
    const { html: out, ctx } = await render('![[Loop]]', { file: loop });
    assert.match(out, /embed-cycle/);
    assert.match(ctx.warnings.join(), /recursive/);
  });
});

describe('comments, tags, block ids', () => {
  it('removes inline and block comments', async () => {
    const out = await html('visible %%hidden%% text\n\n%%\nblock\n\ncomment\n%%\n\nafter');
    assert.doesNotMatch(out, /hidden|block|comment/);
    assert.match(out, /visible  text/);
    assert.match(out, /after/);
  });

  it('keeps comment markers inside code', async () => {
    assert.match(await html('`%%code%%`'), /<code>%%code%%<\/code>/);
  });

  it('leaves unclosed comment markers alone', async () => {
    assert.match(await html('%% not closed\n\ntext'), /%% not closed/);
  });

  it('renders tags but not numbers, anchors or C#', async () => {
    const out = await html('#tag #nested/tag #1984 C# a#b #y1984');
    assert.match(out, /<span class="tag">#tag<\/span>/);
    assert.match(out, /<span class="tag">#nested\/tag<\/span>/);
    assert.match(out, /<span class="tag">#y1984<\/span>/);
    assert.doesNotMatch(out, /#1984<\/span>/);
    assert.match(out, /C#/);
    assert.match(out, /a#b/);
  });

  it('turns ^block-ids into element ids', async () => {
    const out = await html('Para text ^my-id\n\n- item ^li-id\n\n| t |\n|---|\n| 1 |\n\n^table-id');
    assert.match(out, /<p id="\^my-id">Para text<\/p>/);
    assert.match(out, /<li id="\^li-id">item<\/li>/);
    assert.match(out, /<table id="\^table-id">/);
    assert.doesNotMatch(out, /\^table-id<\/p>/);
  });
});
