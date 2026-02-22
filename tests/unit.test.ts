import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import { Renderer } from '../src/renderer.js';
import { parseFrontmatter } from '../src/markdown/frontmatter.js';
import { hasMathSyntax } from '../src/markdown/math.js';
import { hasMermaidSyntax } from '../src/markdown/mermaid.js';
import {
  CDN_MATHJAX_SRC,
  CDN_MERMAID_SRC,
  RUNTIME_ASSET_ROUTES,
  resolveRuntimeAssetSources
} from '../src/assets/resolve.js';
import { verifyRuntimeAssets } from '../src/assets/manager.js';
import { isErrnoException } from '../src/utils/errors.js';
import { normalizePaperFormat, normalizeTocDepth, parseMargin } from '../src/utils/validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const writeRuntimeAssetFixture = async (cacheDir: string): Promise<void> => {
  const runtimeDir = resolve(cacheDir, 'runtime-v1');
  await mkdir(resolve(runtimeDir, 'mathjax/output'), { recursive: true });
  await mkdir(resolve(runtimeDir, 'mathjax-newcm-font/chtml/woff2'), { recursive: true });
  await mkdir(resolve(runtimeDir, 'mermaid'), { recursive: true });

  await writeFile(resolve(runtimeDir, 'mathjax/tex-chtml.js'), '// ok');
  await writeFile(resolve(runtimeDir, 'mathjax/output/chtml.js'), '// ok');
  await writeFile(resolve(runtimeDir, 'mathjax-newcm-font/chtml.js'), '// ok');
  await writeFile(resolve(runtimeDir, 'mathjax-newcm-font/chtml/woff2/mjx-ncm-n.woff2'), 'ok');
  await writeFile(resolve(runtimeDir, 'mermaid/mermaid.min.js'), '// ok');
};

describe('Renderer', () => {
  let renderer: Renderer;

  beforeEach(() => {
    renderer = new Renderer();
  });

  it('initializes with sane defaults', () => {
    // @ts-expect-error intentionally checking internal defaults
    expect(renderer.options.margin).toBe('15mm 10mm');
    // @ts-expect-error intentionally checking internal defaults
    expect(renderer.options.format).toBe('A4');
  });

  it('emits frontmatter warnings during render', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await renderer.renderHtml('---\nfoo: [\n---\n# Content');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('Frontmatter parsing failed');
    } finally {
      warn.mockRestore();
    }
  });

  it('renders basic markdown and heading ids', async () => {
    const html = await renderer.renderHtml('# Heading');
    expect(html).toContain('<h1 id="heading">Heading</h1>');
  });

  it('uses title from frontmatter and escapes it', async () => {
    const html = await renderer.renderHtml('---\ntitle: "<script>x</script>"\n---\n# C');
    expect(html).toContain('<title>&lt;script&gt;x&lt;/script&gt;</title>');
    expect(html).not.toContain('<title><script>x</script></title>');
  });

  it('uses renderer-level title override when provided', async () => {
    const html = await new Renderer({ title: 'Configured Title' }).renderHtml(
      '---\ntitle: Frontmatter Title\n---\n# C'
    );
    expect(html).toContain('<title>Configured Title</title>');
    expect(html).not.toContain('<title>Frontmatter Title</title>');
  });

  it('injects base href when basePath is provided', async () => {
    const html = await new Renderer({ basePath: '/tmp/docs' }).renderHtml('# H');
    expect(html).toContain('<base href="file:///tmp/docs/">');
  });

  it('uses the default layout class only for the built-in template', async () => {
    const defaultHtml = await renderer.renderHtml('# Heading');
    expect(defaultHtml).toContain('<body class="markdown-body convpdf-default-layout">');

    const customTemplateHtml = await new Renderer({
      template: resolve(__dirname, 'fixtures/template.html')
    }).renderHtml('# Heading');
    expect(customTemplateHtml).not.toContain('convpdf-default-layout');
  });

  it('injects raw base href when baseHref is provided', async () => {
    const html = await new Renderer({ baseHref: '../docs/' }).renderHtml('# H');
    expect(html).toContain('<base href="../docs/">');
    expect(html).not.toContain('<base href="file:///');
  });

  it('injects MathJax and Mermaid scripts only when needed', async () => {
    const cdnRenderer = new Renderer({ assetMode: 'cdn' });
    const mathOnly = await cdnRenderer.renderHtml('$x+y$');
    expect(mathOnly).toContain('MathJax-script');
    expect(mathOnly).toContain('mathjax@4/tex-chtml.js');
    expect(mathOnly).not.toContain('mathjax@3/es5/tex-chtml.js');
    expect(mathOnly).not.toContain('Mermaid-script');

    const mermaidOnly = await cdnRenderer.renderHtml('```mermaid\ngraph TD;\nA --> B;\n```');
    expect(mermaidOnly).toContain('Mermaid-script');
    expect(mermaidOnly).not.toContain('language-mermaid');
    expect(mermaidOnly).toContain('<div class="mermaid">graph TD;\nA --&gt; B;</div>');
  });

  it('serializes MathJax inline config without HTML-entity corruption', async () => {
    const html = await new Renderer({
      assetMode: 'cdn',
      mathJaxSrc: 'https://cdn.test/mathjax/tex-chtml.js?x=1&y=2',
      mermaidSrc: 'https://cdn.test/mermaid/mermaid.min.js?x=1&y=2',
      mathJaxBaseUrl: 'https://cdn.test/mathjax?x=1&y=2',
      mathJaxFontBaseUrl: 'https://cdn.test/font?x=1&y=2'
    }).renderHtml('$x+y$');

    expect(html).toContain('"mathjax": "https://cdn.test/mathjax?x=1&y=2"');
    expect(html).toContain('"mathjax-newcm": "https://cdn.test/font?x=1&y=2"');
    expect(html).toContain('"fontURL": "https://cdn.test/font?x=1&y=2/chtml/woff2"');
    expect(html).toContain('src="https://cdn.test/mathjax/tex-chtml.js?x=1&amp;y=2"');
  });

  it('always enables math/mermaid rendering when syntax is present', async () => {
    const withMath = await renderer.renderHtml('$x$');
    expect(withMath).toContain('MathJax-script');

    const withMermaid = await renderer.renderHtml('```mermaid\ngraph TD;\nA-->B;\n```');
    expect(withMermaid).toContain('Mermaid-script');
  });

  it('does not require runtime assets when markdown has no math or mermaid syntax', async () => {
    const strictRenderer = new Renderer({
      assetMode: 'local',
      allowNetworkFallback: false,
      assetCacheDir: resolve(tmpdir(), `convpdf-missing-assets-${Date.now()}`)
    });
    await expect(strictRenderer.renderHtml('# Plain document')).resolves.toContain(
      '<h1 id="plain-document">Plain document</h1>'
    );
  });

  it('supports code highlighting, task lists, tables and footnotes', async () => {
    const html = await renderer.renderHtml(
      '```js\nconst x = 1;\n```\n\n- [x] done\n\n| A | B |\n|:-|-:|\n| 1 | 2 |\n\nRef[^1]\n\n[^1]: note'
    );
    expect(html).toContain('hljs language-js');
    expect(html).toContain('class="hljs-keyword"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('align="left"');
    expect(html).toContain('class="footnotes"');
  });

  it('allows print pagination splits inside tables and code blocks', async () => {
    const html = await renderer.renderHtml('```js\nconst x = 1;\n```\n\n| A |\n| - |\n| 1 |');
    expect(html).toMatch(/@media print[\s\S]*pre\s*\{[\s\S]*page-break-inside:\s*auto;/);
    expect(html).toMatch(/@media print[\s\S]*table\s*\{[\s\S]*page-break-inside:\s*auto;/);
    expect(html).toMatch(/@media print[\s\S]*table\s*\{[\s\S]*table-layout:\s*auto;/);
    expect(html).not.toMatch(/@media print[\s\S]*table\s*\{[\s\S]*table-layout:\s*fixed;/);
    expect(html).toContain('blockquote, .toc, .callout { page-break-inside: avoid; }');
  });

  it('renders page-break markers and preserves markdown link suffixes', async () => {
    const html = await renderer.renderHtml(
      '# A\n\n<!-- PAGE_BREAK -->\n\n[Doc](./guide.md?x=1#top) [Notes](./notes.markdown#frag?x=1)'
    );
    expect(html).toContain('<div class="page-break"></div>');
    expect(html).toContain('href="./guide.pdf?x=1#top"');
    expect(html).toContain('href="./notes.pdf#frag?x=1"');
  });

  it('renders github alert blockquotes as callouts', async () => {
    const html = await renderer.renderHtml(
      '> [!NOTE]\n> Use [the guide](./guide.md).\n>\n> - item 1\n> - item 2'
    );
    expect(html).toContain('class="callout callout-note"');
    expect(html).toContain('<div class="callout-title">Note</div>');
    expect(html).toContain('href="./guide.pdf"');
    expect(html).toContain('<li>item 1</li>');
  });

  it('renders obsidian callouts with custom titles and collapse marker', async () => {
    const html = await renderer.renderHtml(
      '> [!warning]- Read this first\n> Danger zone.\n>\n> `Handle with care`.'
    );
    expect(html).toContain('class="callout callout-warning callout-collapsed"');
    expect(html).toContain('<div class="callout-title">Read this first</div>');
    expect(html).toContain('<p>Danger zone.</p>');
    expect(html).toContain('<code>Handle with care</code>');
  });

  it('keeps non-callout blockquotes unchanged', async () => {
    const html = await renderer.renderHtml('> [! not a callout\n> still quote');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('[! not a callout');
    expect(html).not.toContain('class="callout');
  });

  it('does not treat inline-code PAGE_BREAK text as a real page break marker', async () => {
    const html = await renderer.renderHtml('`<!-- PAGE_BREAK -->`\n\n<!-- PAGE_BREAK -->');
    expect(html).toContain('<p><code>&lt;!-- PAGE_BREAK --&gt;</code></p>');
    const pageBreakMatches = html.match(/<div class="page-break"><\/div>/g) ?? [];
    expect(pageBreakMatches).toHaveLength(1);
  });

  it('keeps distinct inline code spans when there are 10+ placeholders', async () => {
    const html = await renderer.renderHtml(
      [
        '`cargo test`',
        '`desert check`',
        '`examples/*.ds`',
        '`.ds`',
        '`primary -> multiplicative -> additive -> comparison -> assignment`',
        '`move expr`',
        '`std::mem::take(&mut expr)`',
        '`self`',
        '`self`',
        '`&self`',
        '`&mut self`',
        '`@`',
        '`*`',
        '`Resolver`',
        '`tests/check_examples.rs`',
        '`overview.md`',
        '`handoff.md`',
        '`plan.md`'
      ].join(' ')
    );

    expect(html).toContain('<code>cargo test</code>');
    expect(html).toContain('<code>desert check</code>');
    expect(html).toContain('<code>examples/*.ds</code>');
    expect(html).toContain('<code>&amp;self</code>');
    expect(html).toContain('<code>&amp;mut self</code>');
    expect(html).toContain('<code>@</code>');
    expect(html).toContain('<code>*</code>');
    expect(html).not.toContain('<code>cargo test0</code>');
    expect(html).not.toContain('<code>desert check0</code>');
  });

  it('generates TOC for placeholders and global toc mode', async () => {
    const placeholderHtml = await renderer.renderHtml('# One\n\n[TOC]\n\n## Two\n\n[TOC]', {
      toc: true
    });
    const tocMatches = placeholderHtml.match(/class="toc"/g) ?? [];
    expect(tocMatches).toHaveLength(2);
    expect(placeholderHtml).not.toContain('[[TOC_PLACEHOLDER]]');

    const autoTocHtml = await renderer.renderHtml('# Root\n## Child', { toc: true, tocDepth: 2 });
    expect(autoTocHtml).toContain('class="toc"');
    expect(autoTocHtml).toContain('<li class="toc-level-1"><a href="#root">Root</a><ul>');
    expect(autoTocHtml).toContain('<li class="toc-level-2"><a href="#child">Child</a></li>');
    expect(autoTocHtml).toContain('href="#root"');
  });

  it('treats [TOC] as a placeholder only when it appears alone on its own line', async () => {
    const html = await renderer.renderHtml('[TOC]ary\n\n```\n[TOC]\n```\n\n# H', { toc: true });
    const tocMatches = html.match(/class="toc"/g) ?? [];
    expect(tocMatches).toHaveLength(1);
    expect(html).toContain('<p>[TOC]ary</p>');
    expect(html).toContain('<pre><code>[TOC]');
  });

  it('preserves math in heading ids and TOC labels', async () => {
    const html = await renderer.renderHtml('# $x$ heading\n\n## Child $y$', { toc: true });
    expect(html).toContain('<h1 id="x-heading">');
    expect(html).toContain('<h2 id="child-y">');
    expect(html).toContain('href="#x-heading">$x$ heading</a>');
    expect(html).toContain('href="#child-y">Child $y$</a>');
  });

  it('keeps markdown formatting inside link labels and rewrites .md links', async () => {
    const html = await renderer.renderHtml(
      '[**Bold** _Em_](https://example.com) [Doc](./guide.md#top) [Long](./notes.markdown)'
    );
    expect(html).toContain('<a href="https://example.com"><strong>Bold</strong> <em>Em</em></a>');
    expect(html).toContain('href="./guide.pdf#top"');
    expect(html).toContain('href="./notes.pdf"');
  });

  it('rewrites markdown links to .html when html output format is selected', async () => {
    const html = await new Renderer({ linkTargetFormat: 'html' }).renderHtml(
      '[Doc](./guide.md#top) [Long](./notes.markdown)'
    );
    expect(html).toContain('href="./guide.html#top"');
    expect(html).toContain('href="./notes.html"');
  });

  it('sanitizes javascript links', async () => {
    const html = await renderer.renderHtml('[Unsafe](javascript:alert(1))');
    expect(html).toContain('href="#"');
    expect(html).not.toContain('javascript:alert(1)');
  });

  it('allows safe protocols and blocks unsafe protocol links', async () => {
    const html = await renderer.renderHtml(
      '[Mail](mailto:test@example.com) [Phone](tel:+123) [File](file:///tmp/a.md) [Data](data:text/html,1) [ProtoRel](//example.com)'
    );
    expect(html).toContain('href="mailto:test@example.com"');
    expect(html).toContain('href="tel:+123"');
    expect(html).not.toContain('href="file:///tmp/a.md"');
    expect(html).toContain('href="#"');
    expect(html).not.toContain('href="data:text/html,1"');
    expect(html).not.toContain('href="//example.com"');
  });

  it('preserves display and inline math content', async () => {
    const html = await renderer.renderHtml(
      '$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$\n\nInline: $a & b$'
    );
    expect(html).toContain('a &= b \\\\');
    expect(html).toContain('c &= d');
    expect(html).toContain('$a & b$');
    expect(html).not.toContain('$a &amp; b$');
  });

  it('keeps escaped dollars literal without creating MathJax inline delimiters', async () => {
    const html = await renderer.renderHtml('I have \\$100 and \\$50.\n\nBut $x = 5$ is math.');
    expect(html).toContain(
      'I have <span class="convpdf-math-ignore" aria-hidden="true">&#36;</span>100 and <span class="convpdf-math-ignore" aria-hidden="true">&#36;</span>50.'
    );
    expect(html).toContain('But $x = 5$ is math.');
    expect(html).toContain('"ignoreHtmlClass": "convpdf-math-ignore"');
  });

  it('does not treat code blocks as math', async () => {
    const html = await renderer.renderHtml('```tex\n$$\na &= b \\\\\n$$\n```');
    expect(html).toContain('hljs language-tex');
  });

  it('supports custom template and custom css with clear missing-css errors', async () => {
    const tempRoot = await mkdtemp(resolve(tmpdir(), 'convpdf-unit-'));
    try {
      const cssPath = resolve(tempRoot, 'custom.css');
      await writeFile(cssPath, 'body { color: rgb(1, 2, 3); }');

      const customTemplateHtml = await new Renderer({
        template: resolve(__dirname, 'fixtures/template.html')
      }).renderHtml('# HT');
      expect(customTemplateHtml).toContain('Markdown Document - <h1 id="ht">HT</h1>');
      await expect(
        new Renderer({ template: resolve(tempRoot, 'missing-template.html') }).renderHtml('# H')
      ).rejects.toThrow('Failed to read template');

      const customCssHtml = await new Renderer({ customCss: cssPath }).renderHtml('# HT');
      expect(customCssHtml).toContain('rgb(1, 2, 3)');

      await expect(
        new Renderer({ customCss: resolve(tempRoot, 'missing.css') }).renderHtml('# H')
      ).rejects.toThrow('Failed to read custom CSS');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses an empty footer placeholder when only a header template is provided', async () => {
    const rendererWithFakeBrowser = new Renderer();
    const pdfCalls: Array<Record<string, unknown>> = [];

    const fakePage = {
      emulateMediaType: vi.fn(async () => {}),
      setContent: vi.fn(async () => {}),
      goto: vi.fn(async () => {}),
      evaluate: vi.fn(async () => {}),
      pdf: vi.fn(async (options: Record<string, unknown>) => {
        pdfCalls.push(options);
      }),
      close: vi.fn(async () => {})
    };

    // @ts-expect-error injecting a fake browser for unit isolation
    rendererWithFakeBrowser.browser = { newPage: vi.fn(async () => fakePage) } as unknown;

    await rendererWithFakeBrowser.generatePdf(
      '# H',
      resolve(tmpdir(), `convpdf-test-${Date.now()}.pdf`),
      {
        headerTemplate: '<div>H</div>'
      }
    );

    expect(pdfCalls).toHaveLength(1);
    expect(pdfCalls[0]?.displayHeaderFooter).toBe(true);
    expect(pdfCalls[0]?.headerTemplate).toBe('<div>H</div>');
    expect(pdfCalls[0]?.footerTemplate).toBe('<span></span>');
  });

  it('bounds concurrent page creation when maxConcurrentPages is set', async () => {
    const rendererWithFakeBrowser = new Renderer({ maxConcurrentPages: 1, assetMode: 'cdn' });
    let inUsePages = 0;
    let maxInUsePages = 0;

    const makeFakePage = () => ({
      emulateMediaType: vi.fn(async () => {}),
      goto: vi.fn(async () => {}),
      evaluate: vi.fn(async () => {}),
      pdf: vi.fn(async () => {
        await new Promise<void>((resolveDelay) => {
          setTimeout(resolveDelay, 30);
        });
      }),
      close: vi.fn(async () => {
        inUsePages = Math.max(0, inUsePages - 1);
      })
    });

    // @ts-expect-error injecting a fake browser for unit isolation
    rendererWithFakeBrowser.browser = {
      newPage: vi.fn(async () => {
        inUsePages += 1;
        maxInUsePages = Math.max(maxInUsePages, inUsePages);
        return makeFakePage();
      })
    } as unknown;

    await Promise.all([
      rendererWithFakeBrowser.generatePdf(
        '# First',
        resolve(tmpdir(), `convpdf-first-${Date.now()}.pdf`)
      ),
      rendererWithFakeBrowser.generatePdf(
        '# Second',
        resolve(tmpdir(), `convpdf-second-${Date.now()}.pdf`)
      )
    ]);

    expect(maxInUsePages).toBe(1);
  });

  it('keeps document routes alive across cache-dir scoped render servers', async () => {
    const rendererWithDirectServerAccess = new Renderer();

    // @ts-expect-error private method access for lifecycle regression coverage
    const serverA = await rendererWithDirectServerAccess.getRenderServer('/tmp/convpdf-cache-a');
    const docA = serverA.registerDocument();
    docA.setHtml('<!doctype html><html><body>A</body></html>');

    // @ts-expect-error private method access for lifecycle regression coverage
    const serverB = await rendererWithDirectServerAccess.getRenderServer('/tmp/convpdf-cache-b');
    const docB = serverB.registerDocument();
    docB.setHtml('<!doctype html><html><body>B</body></html>');

    const htmlA = await (await fetch(docA.url)).text();
    const htmlB = await (await fetch(docB.url)).text();
    const htmlAAfter = await (await fetch(docA.url)).text();

    expect(htmlA).toContain('<body>A</body>');
    expect(htmlB).toContain('<body>B</body>');
    expect(htmlAAfter).toContain('<body>A</body>');

    docA.dispose();
    docB.dispose();
    await rendererWithDirectServerAccess.close();
  });

  it('deduplicates concurrent render server creation for the same cache dir', async () => {
    const rendererWithDirectServerAccess = new Renderer();
    const cacheDir = resolve(tmpdir(), `convpdf-server-dedupe-${Date.now()}`);
    const getRenderServer = (
      rendererWithDirectServerAccess as unknown as {
        getRenderServer: (assetCacheDir?: string) => Promise<{ baseUrl: string }>;
      }
    ).getRenderServer.bind(rendererWithDirectServerAccess);

    const [serverA, serverB] = await Promise.all([
      getRenderServer(cacheDir),
      getRenderServer(cacheDir)
    ]);

    expect(serverA.baseUrl).toBe(serverB.baseUrl);
    await rendererWithDirectServerAccess.close();
  });

  it('waits for in-flight browser initialization before closing', async () => {
    const rendererWithFakeInit = new Renderer();
    const fakeBrowser = { close: vi.fn(async () => {}) };

    let resolveInit!: () => void;
    const initPromise = new Promise<void>((resolvePromise) => {
      resolveInit = resolvePromise;
    }).then(() => {
      // @ts-expect-error test-only internal state setup
      rendererWithFakeInit.browser = fakeBrowser;
      // @ts-expect-error test-only internal state setup
      rendererWithFakeInit.initializing = null;
    });

    // @ts-expect-error test-only internal state setup
    rendererWithFakeInit.initializing = initPromise;

    const closePromise = rendererWithFakeInit.close();
    expect(fakeBrowser.close).not.toHaveBeenCalled();

    resolveInit();
    await closePromise;
    expect(fakeBrowser.close).toHaveBeenCalledTimes(1);
  });

  it('detects mermaid syntax independently', () => {
    expect(hasMermaidSyntax('```mermaid\ngraph LR;\nA-->B;\n```')).toBe(true);
    expect(hasMermaidSyntax('```js\nconsole.log("plain");\n```')).toBe(false);
  });

  it('generates stable deduplicated anchor IDs for duplicate headings', async () => {
    // IDs are assigned once via the explicit walkTokens call; duplicates should
    // get the standard github-slugger -1/-2 suffixes.
    const html = await renderer.renderHtml('# A\n\n## B\n\n# A\n\n## B');
    const idMatches = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(idMatches).toEqual(['a', 'b', 'a-1', 'b-1']);
  });
});

describe('Asset resolution', () => {
  it('uses CDN URLs when mode is cdn', async () => {
    const resolved = await resolveRuntimeAssetSources({ mode: 'cdn' });
    expect(resolved.mathJaxSrc).toBe(CDN_MATHJAX_SRC);
    expect(resolved.mermaidSrc).toBe(CDN_MERMAID_SRC);
  });

  it('builds localhost runtime asset URLs from shared route constants', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'convpdf-assets-server-routes-'));
    try {
      await writeRuntimeAssetFixture(dir);
      const serverBaseUrl = 'http://127.0.0.1:4545/';
      const localResolved = await resolveRuntimeAssetSources({
        mode: 'auto',
        serverBaseUrl,
        cacheDir: dir,
        allowNetworkFallback: false
      });

      expect(localResolved.mathJaxSrc).toBe(
        `http://127.0.0.1:4545${RUNTIME_ASSET_ROUTES.mathJaxBase}/tex-chtml.js`
      );
      expect(localResolved.mermaidSrc).toBe(
        `http://127.0.0.1:4545${RUNTIME_ASSET_ROUTES.mermaidPath}`
      );
      expect(localResolved.mathJaxBaseUrl).toBe(
        `http://127.0.0.1:4545${RUNTIME_ASSET_ROUTES.mathJaxBase}`
      );
      expect(localResolved.mathJaxFontBaseUrl).toBe(
        `http://127.0.0.1:4545${RUNTIME_ASSET_ROUTES.mathJaxFontBase}`
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws for strict local mode when assets are missing', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'convpdf-assets-missing-'));
    try {
      await expect(
        resolveRuntimeAssetSources({
          mode: 'local',
          cacheDir: dir,
          allowNetworkFallback: false
        })
      ).rejects.toThrow('Local runtime assets are required but missing');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws for strict auto mode when assets are missing and fallback is disabled', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'convpdf-assets-auto-strict-'));
    try {
      await expect(
        resolveRuntimeAssetSources({
          mode: 'auto',
          cacheDir: dir,
          allowNetworkFallback: false
        })
      ).rejects.toThrow('Local runtime assets are required but missing');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to CDN in local mode when fallback is enabled', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'convpdf-assets-fallback-'));
    try {
      const resolved = await resolveRuntimeAssetSources({
        mode: 'local',
        cacheDir: dir,
        allowNetworkFallback: true
      });
      expect(resolved.mathJaxSrc).toBe(CDN_MATHJAX_SRC);
      expect(resolved.mermaidSrc).toBe(CDN_MERMAID_SRC);
      expect(resolved.warning).toContain('Falling back to CDN');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('re-evaluates fallback resolutions after runtime assets are installed', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'convpdf-assets-refresh-'));
    try {
      const first = await resolveRuntimeAssetSources({
        mode: 'auto',
        cacheDir: dir,
        allowNetworkFallback: true
      });
      expect(first.mathJaxSrc).toBe(CDN_MATHJAX_SRC);
      expect(first.mermaidSrc).toBe(CDN_MERMAID_SRC);

      await writeRuntimeAssetFixture(dir);

      const second = await resolveRuntimeAssetSources({
        mode: 'auto',
        cacheDir: dir,
        allowNetworkFallback: true
      });
      expect(second.mathJaxSrc.startsWith('file://')).toBe(true);
      expect(second.mermaidSrc.startsWith('file://')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validates runtime font package layout with at least one woff2 font', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'convpdf-assets-verify-'));
    try {
      await writeRuntimeAssetFixture(dir);
      await expect(verifyRuntimeAssets(dir)).resolves.toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Frontmatter Parsing', () => {
  it('handles missing and empty frontmatter blocks', () => {
    expect(parseFrontmatter('# C')).toEqual({ data: {}, content: '# C', warnings: [] });

    const parsed = parseFrontmatter('---\n---\n# C');
    expect(parsed.data).toEqual({});
    expect(parsed.content.trim()).toBe('# C');
    expect(parsed.warnings).toEqual([]);
  });

  it('returns empty data for non-object frontmatter and unclosed blocks', () => {
    const scalar = parseFrontmatter('---\ntrue\n---\n# C');
    expect(scalar.data).toEqual({});
    expect(scalar.content.trim()).toBe('# C');
    expect(scalar.warnings).toEqual([]);

    const unclosed = parseFrontmatter('---\ntitle: Test\n# C');
    expect(unclosed).toEqual({
      data: {},
      content: '---\ntitle: Test\n# C',
      warnings: []
    });
  });

  it('returns warnings for malformed frontmatter', () => {
    const parsed = parseFrontmatter('---\ni: [\n---\n# C');
    expect(parsed.data).toEqual({});
    expect(parsed.content).toContain('---');
    expect(parsed.warnings).toHaveLength(1);
  });
});

describe('Math Detection', () => {
  it('detects real math and ignores math-like code/link segments', () => {
    expect(hasMathSyntax('Inline $x^2$ math')).toBe(true);
    expect(hasMathSyntax('```js\nconst x = "$not-math$";\n```')).toBe(false);
    expect(hasMathSyntax('[label $x$](https://example.com)')).toBe(true);
  });

  it('does not produce false-positive math detection for multi-backtick code spans', () => {
    // Double-backtick spans enclosing dollar signs must not trigger math detection.
    expect(hasMathSyntax('``$price = 100$``')).toBe(false);
    expect(hasMathSyntax('``$x^2 + y^2$`` is a formula name')).toBe(false);
    // Real inline math outside a code span should still be detected.
    expect(hasMathSyntax('``code`` and $x^2$')).toBe(true);
  });

  it('does not treat dollar signs inside complex markdown link destinations as math', () => {
    expect(hasMathSyntax('[x](https://example.com/path_(a)/?q=$foo$)')).toBe(false);
    expect(hasMathSyntax('![x](https://example.com/path_(a)/?q=$foo$)')).toBe(false);
    expect(hasMathSyntax('[x](https://example.com/path_(a)/?q=1) and $x$')).toBe(true);
  });
});

describe('Validation', () => {
  it('normalizes paper format case-insensitively and rejects invalid formats', () => {
    expect(normalizePaperFormat('a4')).toBe('A4');
    expect(() => normalizePaperFormat('super-a4')).toThrow('Invalid paper format');
  });

  it('parses 1-4 margin shorthands', () => {
    expect(parseMargin('12mm')).toEqual({
      top: '12mm',
      right: '12mm',
      bottom: '12mm',
      left: '12mm'
    });
    expect(parseMargin('12mm 8mm')).toEqual({
      top: '12mm',
      right: '8mm',
      bottom: '12mm',
      left: '8mm'
    });
    expect(parseMargin('1in 2in 3in')).toEqual({
      top: '1in',
      right: '2in',
      bottom: '3in',
      left: '2in'
    });
    expect(parseMargin('10mm 12mm 14mm 16mm')).toEqual({
      top: '10mm',
      right: '12mm',
      bottom: '14mm',
      left: '16mm'
    });
    expect(parseMargin('0')).toEqual({ top: '0', right: '0', bottom: '0', left: '0' });
    expect(parseMargin('0 10mm')).toEqual({ top: '0', right: '10mm', bottom: '0', left: '10mm' });
  });

  it('uses defaults and rejects invalid margin values', () => {
    expect(parseMargin()).toEqual({
      top: '15mm',
      right: '10mm',
      bottom: '15mm',
      left: '10mm'
    });
    expect(() => parseMargin(10)).toThrow('Invalid margin token');
    expect(() => parseMargin('1 2 3 4 5')).toThrow('Invalid margin value');
    expect(() => parseMargin('10qu')).toThrow('Invalid margin token');
    expect(() => parseMargin('1 2 3 4')).toThrow('Invalid margin token');
  });

  it('validates TOC depth bounds and integer constraints', () => {
    expect(normalizeTocDepth()).toBe(6);
    expect(normalizeTocDepth(1)).toBe(1);
    expect(normalizeTocDepth(6)).toBe(6);
    expect(() => normalizeTocDepth(0)).toThrow('between 1 and 6');
    expect(() => normalizeTocDepth(7)).toThrow('between 1 and 6');
    expect(() => normalizeTocDepth(1.5)).toThrow('Expected an integer');
  });
});

describe('Error Utilities', () => {
  it('narrows errno-like errors with isErrnoException', () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const generic = new Error('generic');
    const nonError = { code: 'ENOENT' };

    expect(isErrnoException(enoent)).toBe(true);
    expect(isErrnoException(generic)).toBe(false);
    expect(isErrnoException(nonError)).toBe(false);
  });
});
