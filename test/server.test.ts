/**
 * Web UI server: API behaviour and request filtering.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { findChrome } from '../src/pdf/chrome.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { FIXTURES } from './helpers.ts';

let hasChrome = true;
try {
  findChrome();
} catch {
  hasChrome = false;
}

describe('web UI server', () => {
  let server: RunningServer;
  let dir: string;
  let base: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdpdf-serve-'));
    cpSync(join(FIXTURES, 'vault'), dir, { recursive: true });
    server = await startServer({ root: dir, initialFile: null, port: 0, portFallback: false, host: '127.0.0.1' });
    base = server.url.replace('localhost', '127.0.0.1');
  });
  after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-mdpdf': '1', ...headers } });

  it('serves the app with boot data', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /window.__MDPDF__ = \{/);
    assert.match(html, /"themes":\["default","serif"\]/);
  });

  it('serves the bundled UI script', async () => {
    const res = await fetch(base + '/app.js');
    assert.equal(res.status, 200);
    assert.ok((await res.text()).length > 10_000);
  });

  it('lists markdown files', async () => {
    const data = (await (await fetch(base + '/api/files')).json()) as { files: string[] };
    assert.deepEqual(data.files, ['Home.md', 'notes/Loop.md', 'notes/Project Plan.md']);
  });

  it('reads and writes files', async () => {
    const text = await (await fetch(base + '/api/file?path=Home.md')).text();
    assert.match(text, /^# Home/);
    const put = await fetch(base + '/api/file?path=notes/New.md', { method: 'PUT', body: '# New\n', headers: { 'x-mdpdf': '1' } });
    assert.equal(put.status, 200);
    assert.equal(readFileSync(join(dir, 'notes', 'New.md'), 'utf8'), '# New\n');
  });

  it('refuses paths outside the folder and non-markdown files', async () => {
    assert.equal((await fetch(base + '/api/file?path=../../etc/passwd')).status, 403);
    assert.equal((await fetch(base + '/api/file?path=attachments/pixel.png')).status, 400);
    const put = await fetch(base + '/api/file?path=evil.sh', { method: 'PUT', body: 'x', headers: { 'x-mdpdf': '1' } });
    assert.equal(put.status, 400);
  });

  it('requires the X-Mdpdf header and a matching origin for writes', async () => {
    const noHeader = await fetch(base + '/api/file?path=x.md', { method: 'PUT', body: 'x' });
    assert.equal(noHeader.status, 403);
    const foreign = await fetch(base + '/api/file?path=x.md', { method: 'PUT', body: 'x', headers: { 'x-mdpdf': '1', origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(base + '/api/files', { headers: { host: 'evil.example:80' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  it('renders previews with source lines and served asset URLs', async () => {
    const res = await post('/api/render', { path: 'Home.md', source: '# Title\n\n![[pixel.png]]\n\ntext', options: { theme: 'serif' } });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { html: string; options: { theme: string }; warnings: string[] };
    assert.match(data.html, /<h1 data-line="0" id="title">/);
    assert.match(data.html, /class="theme-serif"/);
    assert.equal(data.options.theme, 'serif');
    const src = /<img src="([^"]+)"/.exec(data.html)?.[1];
    assert.ok(src?.startsWith('/fs/'), String(src));
    const img = await fetch(base + src);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
  });

  it('only serves referenced or in-folder assets', async () => {
    assert.equal((await fetch(base + '/fs/etc/passwd')).status, 404);
    assert.equal((await fetch(base + '/fs' + join(dir, 'Home.md'))).status, 404, 'markdown is not an asset type');
    assert.equal((await fetch(base + '/fs' + join(dir, 'attachments', 'pixel.png'))).status, 200);
  });

  it('ignores options the UI may not set', async () => {
    const res = await post('/api/render', { source: 'x', options: { css: ['/etc/passwd'], timeout: 1 } });
    assert.equal(res.status, 200);
  });

  it('produces PDFs', { skip: !hasChrome && 'Chrome not found' }, async () => {
    const res = await post('/api/pdf', { path: 'Home.md', source: '# Hello\n' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('x-pages'), '1');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  });

  it('reports render errors as JSON', async () => {
    const res = await post('/api/render', { source: 'x', options: { theme: 'nope' } });
    assert.equal(res.status, 500);
    assert.match(((await res.json()) as { error: string }).error, /Unknown theme "nope"/);
  });
});
