import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { join, resolve } from 'path';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'fs/promises';
import { tmpdir } from 'os';

const bin = resolve('dist/bin/convpdf.js');

interface CliRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface CliResult {
  stdout: string;
  stderr: string;
  combined: string;
}

const waitForCondition = async (
  condition: () => boolean,
  timeoutMs = 7000,
  pollMs = 50
): Promise<void> => {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, pollMs);
    });
  }
};

const runCli = (args: string[], options: CliRunOptions): CliResult => {
  const result = spawnSync('node', [bin, ...args], {
    cwd: options.cwd,
    encoding: 'utf-8',
    timeout: 120000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ...options.env
    }
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();
  if (result.status !== 0) {
    throw Object.assign(new Error(`CLI exited with code ${String(result.status)}`), {
      stdout,
      stderr
    });
  }

  return {
    stdout,
    stderr,
    combined: [stdout, stderr].filter(Boolean).join('\n')
  };
};

const runCliExpectFailure = (args: string[], options: CliRunOptions): CliResult => {
  try {
    runCli(args, options);
    throw new Error('Expected CLI command to fail but it succeeded.');
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      const text = String(error);
      return { stdout: '', stderr: text, combined: text };
    }

    const stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout.trim() : '';
    const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    const combined = [stdout, stderr].filter(Boolean).join('\n');

    return { stdout, stderr, combined };
  }
};

describe.sequential('CLI', () => {
  let suiteRoot = '';
  let caseId = 0;

  const createCaseDir = async (label: string): Promise<string> => {
    caseId += 1;
    const dir = join(suiteRoot, `${String(caseId).padStart(2, '0')}-${label}`);
    await mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    suiteRoot = await mkdtemp(join(tmpdir(), 'convpdf-cli-suite-'));
    if (!existsSync(bin)) {
      execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
    }
  });

  afterAll(async () => {
    if (suiteRoot) {
      await rm(suiteRoot, { recursive: true, force: true });
    }
  });

  it('converts a single markdown file to explicit output path', { timeout: 40000 }, async () => {
    const dir = await createCaseDir('single-output');
    await writeFile(join(dir, 'doc.md'), '# Hello\n\nTest');

    runCli(['doc.md', '-o', 'result.pdf'], { cwd: dir });

    expect(existsSync(join(dir, 'result.pdf'))).toBe(true);
  });

  it('converts a single markdown file to adjacent html with --html', async () => {
    const dir = await createCaseDir('single-html-adjacent');
    await writeFile(join(dir, 'doc.md'), '# Hello\n\n[Next](./next.md)');

    runCli(['doc.md', '--html'], { cwd: dir });

    const outputPath = join(dir, 'doc.html');
    expect(existsSync(outputPath)).toBe(true);
    const html = await readFile(outputPath, 'utf-8');
    expect(html).toContain('href="./next.html"');
    expect(html).toContain('<base href="./">');
    expect(html).not.toContain('<base href="file:///');
  });

  it('converts a glob batch into an output directory', { timeout: 60000 }, async () => {
    const dir = await createCaseDir('glob-output-dir');
    await writeFile(join(dir, 'a.md'), '# A');
    await writeFile(join(dir, 'b.markdown'), '# B');

    const result = runCli(['*.m*', '-o', 'out', '-j', '2'], { cwd: dir });

    expect(existsSync(join(dir, 'out', 'a.pdf'))).toBe(true);
    expect(existsSync(join(dir, 'out', 'b.pdf'))).toBe(true);
    expect(result.combined).toContain('Successfully converted 2 file(s).');
  });

  it('converts a glob batch into html output directory', async () => {
    const dir = await createCaseDir('glob-output-dir-html');
    await writeFile(join(dir, 'a.md'), '# A');
    await writeFile(join(dir, 'b.markdown'), '# B');

    runCli(['*.m*', '-o', 'out', '--output-format', 'html'], { cwd: dir });

    expect(existsSync(join(dir, 'out', 'a.html'))).toBe(true);
    expect(existsSync(join(dir, 'out', 'b.html'))).toBe(true);
  });

  it('rewrites generated pdf file links to relative paths', { timeout: 50000 }, async () => {
    const dir = await createCaseDir('pdf-relative-links');
    await writeFile(join(dir, 'doc.md'), '# Main\n\n[Other](./other.md#top)');
    await writeFile(join(dir, 'other.md'), '# Other');

    runCli(['doc.md', '-o', 'doc.pdf'], { cwd: dir });

    const pdf = (await readFile(join(dir, 'doc.pdf'))).toString('latin1');
    expect(pdf).toContain('/URI (./other.pdf#top)');
    expect(pdf).not.toContain('/URI (file:///');
  });

  it('uses config file with relative custom css path', { timeout: 40000 }, async () => {
    const dir = await createCaseDir('config-relative-paths');
    await writeFile(join(dir, 'doc.md'), '# Config Driven');
    await writeFile(join(dir, 'style.css'), 'h1 { color: red; }');
    await writeFile(join(dir, '.convpdfrc.yaml'), 'css: ./style.css\nmargin: 10mm\ntoc: true\n');

    const result = runCli(['doc.md', '-o', 'doc.pdf'], { cwd: dir });

    expect(existsSync(join(dir, 'doc.pdf'))).toBe(true);
    expect(result.combined).toContain('Using config: .convpdfrc.yaml');
  });

  it('supports html output format from config', async () => {
    const dir = await createCaseDir('config-output-format-html');
    await writeFile(join(dir, 'doc.md'), '# Config Html\n\n[Ref](./guide.md)');
    await writeFile(join(dir, '.convpdfrc.yaml'), 'outputFormat: html\n');

    runCli(['doc.md'], { cwd: dir });

    const outputPath = join(dir, 'doc.html');
    expect(existsSync(outputPath)).toBe(true);
    const html = await readFile(outputPath, 'utf-8');
    expect(html).toContain('href="./guide.html"');
  });

  it('applies config values when CLI flags are omitted', { timeout: 50000 }, async () => {
    const dir = await createCaseDir('config-precedence');
    await writeFile(join(dir, 'doc.md'), '# C');
    await writeFile(join(dir, '.convpdfrc.yaml'), 'margin: "1 2 3 4 5"\nconcurrency: 2\n');

    const result = runCliExpectFailure(['doc.md'], { cwd: dir });

    expect(result.combined).toContain('Using config: .convpdfrc.yaml');
    expect(result.combined).toContain('Invalid margin value');
  });

  it('fails on malformed config with actionable error', async () => {
    const dir = await createCaseDir('bad-config');
    await writeFile(join(dir, 'doc.md'), '# C');
    await writeFile(join(dir, '.convpdfrc.yaml'), 'margin: [');

    const result = runCliExpectFailure(['doc.md'], { cwd: dir });

    expect(result.combined).toContain('Failed to parse config');
  });

  it('fails when config root is not an object', async () => {
    const dir = await createCaseDir('invalid-config-root');
    await writeFile(join(dir, 'doc.md'), '# C');
    await writeFile(join(dir, '.convpdfrc.yaml'), '- one\n- two\n');

    const result = runCliExpectFailure(['doc.md'], { cwd: dir });

    expect(result.combined).toContain('Expected object at root of config');
  });

  it('fails when single output pdf is used with expandable inputs', async () => {
    const dir = await createCaseDir('single-pdf-with-glob');
    await writeFile(join(dir, 'a.md'), '# A');
    await writeFile(join(dir, 'b.md'), '# B');

    const result = runCliExpectFailure(['*.md', '-o', 'single.pdf'], { cwd: dir });

    expect(result.combined).toContain('can expand to multiple markdown files');
  });

  it('fails when single output html is used with expandable inputs', async () => {
    const dir = await createCaseDir('single-html-with-glob');
    await writeFile(join(dir, 'a.md'), '# A');
    await writeFile(join(dir, 'b.md'), '# B');

    const result = runCliExpectFailure(['*.md', '-o', 'single.html', '--output-format', 'html'], {
      cwd: dir
    });

    expect(result.combined).toContain('single .html file');
  });

  it('fails on invalid output format with clear error', async () => {
    const dir = await createCaseDir('invalid-output-format');
    await writeFile(join(dir, 'doc.md'), '# Hello');

    const result = runCliExpectFailure(['doc.md', '--output-format', 'txt'], { cwd: dir });

    expect(result.combined).toContain('Invalid output format');
    expect(result.combined).toContain('pdf');
    expect(result.combined).toContain('html');
  });

  it('fails on invalid paper format with clear error', { timeout: 50000 }, async () => {
    const dir = await createCaseDir('invalid-format');
    await writeFile(join(dir, 'doc.md'), '# Hello');

    const result = runCliExpectFailure(['doc.md', '--format', 'INVALID'], { cwd: dir });

    expect(result.combined).toContain('Invalid paper format');
  });

  it(
    'leaves no convpdf temp artifacts after conversion (TMPDIR scoped)',
    { timeout: 50000 },
    async () => {
      const dir = await createCaseDir('tmp-cleanup');
      const isolatedTmp = join(dir, '.tmp');
      await mkdir(isolatedTmp, { recursive: true });

      await writeFile(join(dir, 'doc.md'), '# Image\n\n![x](./pixel.png)');
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64'
      );
      await writeFile(join(dir, 'pixel.png'), png);

      runCli(['doc.md', '-o', 'doc.pdf'], {
        cwd: dir,
        env: {
          TMPDIR: isolatedTmp,
          TMP: isolatedTmp,
          TEMP: isolatedTmp
        }
      });

      const leftovers = (await readdir(isolatedTmp)).filter((entry) =>
        entry.startsWith('convpdf-')
      );
      expect(leftovers).toEqual([]);
      const pdfPath = join(dir, 'doc.pdf');
      expect(existsSync(pdfPath)).toBe(true);

      // Regression guard: ensure local images are embedded in the generated PDF.
      const pdfBuffer = await readFile(pdfPath);
      const imageObjectCount = (pdfBuffer.toString('latin1').match(/\/Subtype \/Image/g) ?? [])
        .length;
      expect(imageObjectCount).toBeGreaterThan(0);
    }
  );

  it('fails on missing inputs', async () => {
    const dir = await createCaseDir('missing-inputs');
    const result = runCliExpectFailure(['nope.md'], { cwd: dir });
    expect(result.combined).toContain('No input markdown files found');
  });

  it('surfaces non-ENOENT filesystem errors while inspecting explicit file inputs', async () => {
    if (process.platform === 'win32') return;

    const dir = await createCaseDir('input-loop-error');
    await symlink('loop.md', join(dir, 'loop.md'));

    const result = runCliExpectFailure(['loop.md'], { cwd: dir });
    expect(result.combined).toContain('Failed to inspect input path "loop.md"');
    expect(result.combined).toContain('ELOOP');
  });

  it('supports custom templates with header and footer', { timeout: 50000 }, async () => {
    const dir = await createCaseDir('template-header-footer');
    await writeFile(join(dir, 'doc.md'), '# Title');
    await writeFile(
      join(dir, 'template.html'),
      '<!DOCTYPE html><html><head><title>{{title}}</title></head><body>{{content}}</body></html>'
    );
    await writeFile(join(dir, 'header.html'), '<div style="font-size:8px">H</div>');
    await writeFile(
      join(dir, 'footer.html'),
      '<div style="font-size:8px"><span class="pageNumber"></span></div>'
    );

    runCli(
      [
        'doc.md',
        '--template',
        'template.html',
        '--header',
        'header.html',
        '--footer',
        'footer.html',
        '-o',
        'doc.pdf'
      ],
      { cwd: dir }
    );

    expect(existsSync(join(dir, 'doc.pdf'))).toBe(true);
  });

  it('fails when header or footer template files are missing', async () => {
    const dir = await createCaseDir('missing-header-footer');
    await writeFile(join(dir, 'doc.md'), '# Title');

    const headerFailure = runCliExpectFailure(['doc.md', '--header', 'missing-header.html'], {
      cwd: dir
    });
    expect(headerFailure.combined).toContain('Failed to read template file "missing-header.html"');

    const footerFailure = runCliExpectFailure(['doc.md', '--footer', 'missing-footer.html'], {
      cwd: dir
    });
    expect(footerFailure.combined).toContain('Failed to read template file "missing-footer.html"');
  });

  it('ignores pdf-only header/footer templates when html output is selected', async () => {
    const dir = await createCaseDir('html-ignores-header-footer');
    await writeFile(join(dir, 'doc.md'), '# Title');

    runCli(['doc.md', '--header', 'missing-header.html', '--html'], { cwd: dir });

    expect(existsSync(join(dir, 'doc.html'))).toBe(true);
  });

  it('renders mermaid diagrams in generated PDFs', { timeout: 50000 }, async () => {
    const dir = await createCaseDir('mermaid');
    await writeFile(join(dir, 'diagram.md'), '```mermaid\ngraph TD;\nA --> B;\n```');

    runCli(['diagram.md', '-o', 'diagram.pdf'], { cwd: dir });

    expect(existsSync(join(dir, 'diagram.pdf'))).toBe(true);
  });

  it('honors toc depth validation and integer parsing errors', async () => {
    const dir = await createCaseDir('toc-and-int-validation');
    await writeFile(join(dir, 'doc.md'), '# A\n## B');

    const badDepth = runCliExpectFailure(['doc.md', '--toc-depth', '0'], { cwd: dir });
    expect(badDepth.combined).toContain('between 1 and 6');

    const badTocInteger = runCliExpectFailure(['doc.md', '--toc-depth', '2abc'], { cwd: dir });
    expect(badTocInteger.combined).toContain('Invalid integer');

    const badConcurrencyInteger = runCliExpectFailure(['doc.md', '-j', '2abc'], { cwd: dir });
    expect(badConcurrencyInteger.combined).toContain('Invalid integer');
  });

  it('fails on concurrency above supported max', { timeout: 60000 }, async () => {
    const dir = await createCaseDir('concurrency-cap');
    await writeFile(join(dir, '1.md'), '# 1');
    await writeFile(join(dir, '2.md'), '# 2');

    const result = runCliExpectFailure(['*.md', '-j', '999'], { cwd: dir });

    expect(result.combined).toContain('Invalid concurrency value');
    expect(result.combined).toContain('between 1 and 32');
  });

  it(
    'accepts --max-pages and config maxConcurrentPages for renderer page pooling',
    { timeout: 50000 },
    async () => {
      const dir = await createCaseDir('max-pages');
      await writeFile(join(dir, 'doc.md'), '# Pooled');
      await writeFile(join(dir, '.convpdfrc.yaml'), 'maxConcurrentPages: 1\n');

      runCli(['doc.md', '--max-pages', '1'], { cwd: dir });

      expect(existsSync(join(dir, 'doc.pdf'))).toBe(true);
    }
  );

  it('fails on max-pages values outside supported range', async () => {
    const dir = await createCaseDir('max-pages-range');
    await writeFile(join(dir, 'doc.md'), '# Pooled');

    const result = runCliExpectFailure(['doc.md', '--max-pages', '999'], { cwd: dir });

    expect(result.combined).toContain('Invalid max pages value');
    expect(result.combined).toContain('between 1 and 128');
  });

  it('fails when output directory mapping would collide', async () => {
    const dir = await createCaseDir('output-collision');
    await mkdir(join(dir, 'a'), { recursive: true });
    await mkdir(join(dir, 'b'), { recursive: true });
    await writeFile(join(dir, 'a', 'doc.md'), '# A');
    await writeFile(join(dir, 'b', 'doc.md'), '# B');

    const result = runCliExpectFailure(['a/doc.md', 'b/doc.md', '-o', 'out'], { cwd: dir });

    expect(result.combined).toContain('Output path collision');
  });

  it('preserves directory structure in output directory', { timeout: 50000 }, async () => {
    const dir = await createCaseDir('preserve-structure');
    await mkdir(join(dir, 'docs', 'sub'), { recursive: true });
    await writeFile(join(dir, 'docs', 'a.md'), '# A');
    await writeFile(join(dir, 'docs', 'sub', 'b.md'), '# B');

    runCli(['docs', '-o', 'out'], { cwd: dir });

    expect(existsSync(join(dir, 'out', 'a.pdf'))).toBe(true);
    expect(existsSync(join(dir, 'out', 'sub', 'b.pdf'))).toBe(true);
  });

  it('writes output next to markdown by default', { timeout: 40000 }, async () => {
    const dir = await createCaseDir('default-output');
    await writeFile(join(dir, 'doc.md'), '# Local Output');

    runCli(['doc.md'], { cwd: dir });

    expect(existsSync(join(dir, 'doc.pdf'))).toBe(true);
  });

  it('treats literal parentheses in filenames as non-glob input', { timeout: 50000 }, async () => {
    const dir = await createCaseDir('literal-parentheses-name');
    await writeFile(join(dir, 'spec (draft).md'), '# Spec');

    runCli(['spec (draft).md', '-o', 'out.pdf'], { cwd: dir });

    expect(existsSync(join(dir, 'out.pdf'))).toBe(true);
  });

  it(
    'treats literal glob-like characters in filenames as direct file inputs',
    { timeout: 50000 },
    async () => {
      const dir = await createCaseDir('literal-glob-chars');
      await writeFile(join(dir, 'spec [draft].md'), '# Spec');

      runCli(['spec [draft].md', '-o', 'out.pdf'], { cwd: dir });

      expect(existsSync(join(dir, 'out.pdf'))).toBe(true);
    }
  );

  it('starts watch mode even when no markdown files exist initially', async () => {
    const dir = await createCaseDir('watch-empty-start');
    await mkdir(join(dir, 'docs'), { recursive: true });

    const result = spawnSync('node', [bin, 'docs/*.md', '--watch'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 3000,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
    });

    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(combined).toContain('No input markdown files found yet. Watching for new files');
    expect(combined).toContain('Watching for changes... (Press Ctrl+C to stop)');
  });

  it(
    'watch mode only reacts to files that match the original glob',
    { timeout: 25000 },
    async () => {
      const dir = await createCaseDir('watch-glob-boundary');
      await mkdir(join(dir, 'docs', 'sub'), { recursive: true });

      const child = spawn('node', [bin, 'docs/*.md', '--watch', '--html', '-o', 'out'], {
        cwd: dir,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
      });

      let combined = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        combined += chunk.toString('utf-8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        combined += chunk.toString('utf-8');
      });

      try {
        await waitForCondition(() => combined.includes('Watching for changes...'), 10000);

        await writeFile(join(dir, 'docs', 'sub', 'skip.md'), '# Skip');
        await new Promise<void>((resolveDelay) => {
          setTimeout(resolveDelay, 1200);
        });

        expect(existsSync(join(dir, 'out', 'sub', 'skip.html'))).toBe(false);
        expect(combined).not.toContain('docs/sub/skip.md');

        await writeFile(join(dir, 'docs', 'match.md'), '# Match');
        await waitForCondition(() => existsSync(join(dir, 'out', 'match.html')), 10000);
        expect(combined).toContain('docs/match.md');
      } finally {
        child.kill('SIGINT');
        await new Promise<void>((resolveDone) => {
          const timer = setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
            resolveDone();
          }, 5000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolveDone();
          });
        });
      }
    }
  );

  it(
    'preserves file timestamps when --preserve-timestamp is used',
    { timeout: 40000 },
    async () => {
      const dir = await createCaseDir('preserve-timestamp');
      const mdPath = join(dir, 'doc.md');
      const pdfPath = join(dir, 'doc.pdf');
      await writeFile(mdPath, '# Timestamp');

      const pastDate = new Date(2025, 0, 1, 0, 0, 0);
      await utimes(mdPath, pastDate, pastDate);

      runCli(['doc.md', '--preserve-timestamp'], { cwd: dir });

      expect(existsSync(pdfPath)).toBe(true);
      const pdfStats = await stat(pdfPath);
      expect(Math.floor(pdfStats.mtime.getTime() / 1000)).toBe(
        Math.floor(pastDate.getTime() / 1000)
      );
    }
  );

  it('supports assets clean command with json output', async () => {
    const dir = await createCaseDir('assets-clean');
    const raw = runCli(['assets', 'clean', '--json'], { cwd: dir });
    const parsed = JSON.parse(raw.stdout) as { operation: string; cleaned: boolean };
    expect(parsed.operation).toBe('clean');
    expect(parsed.cleaned).toBe(true);
  });

  it('shows assets command help', async () => {
    const dir = await createCaseDir('assets-help');
    const raw = runCli(['assets', '--help'], { cwd: dir });
    expect(raw.stdout).toContain('Usage: convpdf assets');
    expect(raw.stdout).toContain('install|verify|update|clean');
  });

  it('supports --cache-dir=<path> syntax in assets commands', async () => {
    const dir = await createCaseDir('assets-cache-dir-equals');
    const cacheDir = resolve(dir, 'assets-cache');
    const raw = runCli(['assets', 'clean', `--cache-dir=${cacheDir}`, '--json'], { cwd: dir });
    const parsed = JSON.parse(raw.stdout) as { operation: string; cacheDir: string };
    expect(parsed.operation).toBe('clean');
    expect(parsed.cacheDir).toBe(cacheDir);
  });

  it('enforces strict local assets policy from config', async () => {
    const dir = await createCaseDir('config-strict-local-assets');
    const cacheDir = join(dir, 'cache');
    await writeFile(join(dir, 'doc.md'), '# Offline only\n\n$x = 1$');
    await writeFile(
      join(dir, '.convpdfrc.yaml'),
      `assetMode: local\nallowNetworkFallback: false\nassetCacheDir: ${cacheDir}\n`
    );

    const result = runCliExpectFailure(['doc.md'], { cwd: dir });
    expect(result.combined).toContain('Local runtime assets are required but missing');
    expect(result.combined).toContain('convpdf assets install');
  });

  it(
    'allows strict local assets policy when the document does not need runtime assets',
    { timeout: 50000 },
    async () => {
      const dir = await createCaseDir('config-strict-local-assets-no-runtime');
      const cacheDir = join(dir, 'cache');
      await writeFile(join(dir, 'doc.md'), '# Offline plain text');
      await writeFile(
        join(dir, '.convpdfrc.yaml'),
        `assetMode: local\nallowNetworkFallback: false\nassetCacheDir: ${cacheDir}\n`
      );

      runCli(['doc.md'], { cwd: dir });

      expect(existsSync(join(dir, 'doc.pdf'))).toBe(true);
    }
  );

  it('enforces strict auto assets policy when fallback is disabled via CLI', async () => {
    const dir = await createCaseDir('cli-strict-auto-assets');
    const cacheDir = join(dir, 'cache');
    await writeFile(join(dir, 'doc.md'), '# Auto strict\n\n```mermaid\ngraph TD;\nA --> B;\n```');

    const result = runCliExpectFailure(
      ['doc.md', '--asset-mode', 'auto', '--no-asset-fallback', '--asset-cache-dir', cacheDir],
      { cwd: dir }
    );

    expect(result.combined).toContain('Local runtime assets are required but missing');
    expect(result.combined).toContain('convpdf assets install');
  });

  it('fails fast on invalid concurrency type from config', async () => {
    const dir = await createCaseDir('invalid-concurrency-type');
    await writeFile(join(dir, 'doc.md'), '# C');
    await writeFile(join(dir, '.convpdfrc.yaml'), 'concurrency: "many"\n');

    const result = runCliExpectFailure(['doc.md'], { cwd: dir });

    expect(result.combined).toContain('Invalid concurrency value');
  });
});
