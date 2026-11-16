import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { MermaidCache } from '../src/mermaid-cache.ts';

describe('Mermaid diagram cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'convpdf-cache-test-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  const svg = '<svg id="mermaid-123" xmlns="http://www.w3.org/2000/svg"><style>#mermaid-123 .node{fill:red}</style><path marker-end="url(#mermaid-123_arrow)"/></svg>';
  const block = (src: string) => `<div class="mermaid-diagram"><pre class="mermaid">${src}</pre></div>`;

  it('leaves unknown diagrams for the page to render', () => {
    const cache = new MermaidCache(join(root, 'a'));
    const body = block('graph TD; A--&gt;B');
    const result = cache.inline(body, 'scope');
    assert.equal(result.body, body);
    assert.equal(result.missing, 1);
  });

  it('inlines stored diagrams with unique ids, keyed by unescaped source and scope', async () => {
    const dir = join(root, 'b');
    await new MermaidCache(dir).store('scope', [['graph TD; A-->B', svg]]);
    const cache = new MermaidCache(dir); // fresh instance reads from disk
    const result = cache.inline(block('graph TD; A--&gt;B') + block('graph TD; A--&gt;B'), 'scope');
    assert.equal(result.missing, 0);
    assert.match(result.body, /<pre class="mermaid" data-processed="true" data-source="graph TD; A--&gt;B"><svg id="mermaid-c1"/);
    assert.match(result.body, /#mermaid-c2 \.node/);
    assert.match(result.body, /url\(#mermaid-c2_arrow\)/);
    assert.doesNotMatch(result.body, /mermaid-123/);
    assert.equal(cache.inline(block('graph TD; A--&gt;B'), 'other scope').missing, 1);
  });

  it('prunes the least recently used entries', () => {
    const cache = new MermaidCache(join(root, 'c'));
    const dir = cache.dir;
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 6; i++) {
      const f = join(dir, `${i}.svg`);
      writeFileSync(f, svg);
      utimesSync(f, new Date(1000 * i), new Date(1000 * i));
    }
    cache.prune(5, 3);
    assert.deepEqual(readdirSync(dir).sort(), ['3.svg', '4.svg', '5.svg']);
  });
});
