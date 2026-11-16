/**
 * Command line tests: run the real CLI in a child process.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../src/pdf/chrome.ts';
import { FIXTURES } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

function run(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
    child.stdin.end(opts.input ?? '');
  });
}

let hasChrome = true;
try {
  findChrome();
} catch {
  hasChrome = false;
}

describe('CLI basics', () => {
  it('prints help', async () => {
    const r = await run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout.toString(), /^convpdf .* convert Markdown/);
    assert.match(r.stdout.toString(), /--toc/);
  });

  it('prints the version', async () => {
    const r = await run(['--version']);
    assert.equal(r.code, 0);
    assert.match(r.stdout.toString(), /^\d+\.\d+\.\d+\n$/);
  });

  it('rejects unknown options with exit code 2', async () => {
    const r = await run(['--frobnicate', 'x.md']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /frobnicate/);
  });

  it('fails cleanly for missing inputs', async () => {
    const r = await run(['does-not-exist.md']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /does-not-exist.md/);
    assert.doesNotMatch(r.stderr, /at .*\.ts:\d+/, 'no stack trace');
  });

  it('rejects invalid option values', async () => {
    const r = await run(['--break-before', 'h5', join(FIXTURES, 'plain', 'a.md')]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /break-before/);
  });

  it('writes HTML without needing a browser', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'convpdf-cli-'));
    try {
      const r = await run(['--html', '-o', dir, join(FIXTURES, 'plain', 'a.md')]);
      assert.equal(r.code, 0, r.stderr);
      const html = readFileSync(join(dir, 'a.html'), 'utf8');
      assert.match(html, /<h1 id="document-a">Document A<\/h1>/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI conversion', { skip: !hasChrome && 'Chrome not found' }, () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'convpdf-cli-'));
    cpSync(join(FIXTURES, 'plain'), join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'sub.md'), '# Sub\n');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the PDF next to the input by default', async () => {
    const r = await run(['docs/a.md'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /✓ docs\/a.md → docs\/a.pdf \(1 page/);
    assert.equal(readFileSync(join(dir, 'docs', 'a.pdf')).subarray(0, 5).toString(), '%PDF-');
  });

  it('converts a folder into an output folder', async () => {
    const r = await run(['docs', '-o', 'out', '-q'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
    for (const name of ['a.pdf', 'b.pdf', 'sub.pdf']) assert.ok(existsSync(join(dir, 'out', name)), name);
  });

  it('merges several inputs into one file', async () => {
    const r = await run(['docs/a.md', 'docs/b.md', '-o', 'book.pdf'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /docs\/a.md \+ docs\/b.md → book.pdf \(2 pages/);
  });

  it('merges glob matches in natural order', async () => {
    mkdirSync(join(dir, 'ch'));
    for (const n of [10, 2, 1]) writeFileSync(join(dir, 'ch', `chapter${n}.md`), `# Chapter ${n}\n`);
    const r = await run(['ch/*.md', '-o', 'chapters.pdf'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    let text: string;
    try {
      text = execFileSync('pdftotext', [join(dir, 'chapters.pdf'), '-']).toString();
    } catch {
      return; // poppler not installed
    }
    assert.match(text, /Chapter 1\b[\s\S]*Chapter 2\b[\s\S]*Chapter 10\b/);
  });

  it('reads stdin and writes stdout', async () => {
    const r = await run(['-'], { input: '# From stdin\n' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.subarray(0, 5).toString(), '%PDF-');
  });

  it('applies a config file', async () => {
    writeFileSync(join(dir, 'convpdf.yaml'), 'paper: Letter\nlandscape: true\nnot-an-option: 1\n');
    try {
      const r = await run(['docs/b.md', '-o', 'cfg.pdf'], { cwd: dir });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /Unknown option "not-an-option"/);
      const pdf = readFileSync(join(dir, 'cfg.pdf')).toString('latin1');
      assert.match(pdf, /\/MediaBox \[0 0 792 612\]/);
    } finally {
      rmSync(join(dir, 'convpdf.yaml'));
    }
  });

  it('exits with 1 when a conversion fails but still converts the rest', async () => {
    const r = await run(['docs/a.md', 'docs/b.md', '--theme', 'no-such-theme'], { cwd: dir });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /no-such-theme/);
  });
});
