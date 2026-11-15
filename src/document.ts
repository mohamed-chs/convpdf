/**
 * Assemble the full HTML document that Chrome prints: theme CSS, fonts,
 * page setup (@page size, margins, header/footer margin boxes), the rendered
 * markdown, and a small readiness script.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetResolver } from './markdown/types.ts';
import type { ConvertOptions } from './options.ts';

export const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const THEMES_DIR = resolve(PKG_ROOT, 'themes');

interface ThemeDef {
  fonts: string[];
  /** Font family used in page margin boxes (headers/footers). */
  marginFont: string;
  /** Mermaid "base" theme variables matching the theme. */
  mermaid: Record<string, string>;
}

const MERMAID_DEFAULT = {
  fontSize: '13px',
  primaryColor: '#f6f8fa',
  primaryBorderColor: '#afb8c1',
  primaryTextColor: '#1f2328',
  secondaryColor: '#ddf4ff',
  secondaryBorderColor: '#54aeff',
  tertiaryColor: '#ffffff',
  tertiaryBorderColor: '#d1d9e0',
  lineColor: '#59636e',
  textColor: '#1f2328',
  noteBkgColor: '#fff8c5',
  noteBorderColor: '#d4a72c',
  noteTextColor: '#1f2328',
  actorBkg: '#f6f8fa',
  actorBorder: '#afb8c1',
  labelBoxBkgColor: '#f6f8fa',
  clusterBkg: '#f6f8fa',
  clusterBorder: '#d1d9e0',
  edgeLabelBackground: '#ffffff',
  // Charts need saturated, distinguishable colours.
  pie1: '#6e9bd8',
  pie2: '#f2a65a',
  pie3: '#7cc49a',
  pie4: '#b99ad6',
  pie5: '#e57f7f',
  pie6: '#5ec4cc',
  pie7: '#e8c95c',
  pie8: '#a1887f',
  pieStrokeColor: '#ffffff',
  pieStrokeWidth: '1.5px',
  pieOuterStrokeWidth: '0px',
  pieSectionTextColor: '#1f2328',
  pieTitleTextSize: '15px',
  taskBkgColor: '#ddf4ff',
  taskBorderColor: '#54aeff',
  taskTextColor: '#1f2328',
  taskTextDarkColor: '#1f2328',
  taskTextOutsideColor: '#1f2328',
  activeTaskBkgColor: '#b6e3ff',
  activeTaskBorderColor: '#0969da',
  doneTaskBkgColor: '#d1d9e0',
  doneTaskBorderColor: '#8c959f',
  critBkgColor: '#ffd8d3',
  critBorderColor: '#cf222e',
  sectionBkgColor: '#f6f8fa',
  altSectionBkgColor: '#ffffff',
  sectionBkgColor2: '#f6f8fa',
  gridColor: '#e5e9ee',
  todayLineColor: '#cf222e',
  git0: '#6e9bd8',
  git1: '#f2a65a',
  git2: '#7cc49a',
  git3: '#b99ad6',
};

const MONO_FONTS = ['@fontsource/jetbrains-mono/400.css', '@fontsource/jetbrains-mono/400-italic.css', '@fontsource/jetbrains-mono/700.css'];
const INTER_FONTS = [
  '@fontsource/inter/400.css',
  '@fontsource/inter/400-italic.css',
  '@fontsource/inter/500.css',
  '@fontsource/inter/600.css',
  '@fontsource/inter/600-italic.css',
  '@fontsource/inter/700.css',
  '@fontsource/inter/700-italic.css',
];
const SERIF_FONTS = [
  '@fontsource/source-serif-4/400.css',
  '@fontsource/source-serif-4/400-italic.css',
  '@fontsource/source-serif-4/600.css',
  '@fontsource/source-serif-4/600-italic.css',
  '@fontsource/source-serif-4/700.css',
  '@fontsource/source-serif-4/700-italic.css',
];

export const THEMES: Record<string, ThemeDef> = {
  default: { fonts: [...INTER_FONTS, ...MONO_FONTS], marginFont: "'Inter', sans-serif", mermaid: MERMAID_DEFAULT },
  serif: {
    fonts: [...SERIF_FONTS, ...MONO_FONTS],
    marginFont: "'Source Serif 4', serif",
    mermaid: {
      ...MERMAID_DEFAULT,
      fontSize: '14px',
      primaryColor: '#f7f7f5',
      primaryBorderColor: '#8a8a8a',
      primaryTextColor: '#222222',
      secondaryColor: '#eef2f7',
      secondaryBorderColor: '#1d4f91',
      lineColor: '#555555',
      textColor: '#222222',
      actorBkg: '#f7f7f5',
      actorBorder: '#8a8a8a',
      clusterBkg: '#f7f7f5',
      clusterBorder: '#cccccc',
    },
  },
};

export function themeNames(): string[] {
  return Object.keys(THEMES);
}

const fileCache = new Map<string, string>();

function readCached(path: string): string {
  let text = fileCache.get(path);
  if (text === undefined) {
    text = readFileSync(path, 'utf8');
    fileCache.set(path, text);
  }
  return text;
}

export function resolvePackageFile(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}

/** @font-face rules from a Fontsource stylesheet, pointing at the font files. */
function fontFaceCss(specifier: string, resolver: AssetResolver): string {
  const cssPath = resolvePackageFile(specifier);
  const dir = dirname(cssPath);
  return readCached(cssPath)
    .replace(/font-display:\s*swap/g, 'font-display: block')
    .replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, '')
    .replace(/url\(\.\/([^)]+)\)/g, (_, rel: string) => `url(${resolver.file(resolve(dir, rel))})`);
}

function cssString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\A ')}"`;
}

export interface TemplateValues {
  title: string;
  author: string;
  date: string;
  file: string;
}

/** Turn "Page {page} of {pages}" into a CSS `content` value. */
function templateContent(template: string, values: TemplateValues): string {
  const parts: string[] = [];
  let last = 0;
  const re = /\{(page|pages|title|author|date|file)\}/g;
  for (const m of template.matchAll(re)) {
    if (m.index > last) parts.push(cssString(template.slice(last, m.index)));
    const key = m[1]!;
    if (key === 'page') parts.push('counter(page)');
    else if (key === 'pages') parts.push('counter(pages)');
    else parts.push(cssString(values[key as keyof TemplateValues] ?? ''));
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push(cssString(template.slice(last)));
  return parts.length ? parts.join(' ') : 'none';
}

/** "left|center|right" (or "left|right", or "center") → margin box contents. */
function splitTemplate(template: string): { left?: string; center?: string; right?: string } {
  if (!template.trim()) return {};
  const parts = template.split(/(?<!\\)\|/).map((p) => p.replace(/\\\|/g, '|'));
  if (parts.length === 1) return { center: parts[0] };
  if (parts.length === 2) return { left: parts[0], right: parts[1] };
  return { left: parts[0], center: parts[1], right: parts.slice(2).join('|') };
}

const PAPER_SIZES: Record<string, string> = {
  a3: 'A3',
  a4: 'A4',
  a5: 'A5',
  a6: '105mm 148mm',
  b4: 'B4',
  b5: 'B5',
  letter: 'letter',
  legal: 'legal',
  ledger: 'ledger',
  tabloid: '11in 17in',
  executive: '7.25in 10.5in',
};

export function pageSizeCss(paper: string, landscape: boolean): string {
  const key = paper.trim().toLowerCase();
  let size = PAPER_SIZES[key];
  if (!size) {
    const custom = /^([\d.]+\s*(?:mm|cm|in|pt|px))\s*(?:x|\s)\s*([\d.]+\s*(?:mm|cm|in|pt|px))$/i.exec(paper.trim());
    if (!custom) throw new Error(`Unknown paper size "${paper}". Use A4, Letter, Legal, A3, A5, ... or a size like "210mm 297mm".`);
    size = `${custom[1]!.replace(/\s+/g, '')} ${custom[2]!.replace(/\s+/g, '')}`;
  }
  if (!landscape) return size;
  // Keywords accept "landscape"; explicit sizes are swapped.
  const dims = size.split(' ');
  return dims.length === 2 ? `${dims[1]} ${dims[0]}` : `${size} landscape`;
}

const PAPER_DIMENSIONS: Record<string, [string, string]> = {
  a3: ['297mm', '420mm'],
  a4: ['210mm', '297mm'],
  a5: ['148mm', '210mm'],
  b4: ['250mm', '353mm'],
  b5: ['176mm', '250mm'],
  letter: ['8.5in', '11in'],
  legal: ['8.5in', '14in'],
  ledger: ['11in', '17in'],
};

/** Paper width and height as CSS lengths (for the on-screen preview). */
export function paperDimensions(paper: string, landscape: boolean): [string, string] {
  const size = pageSizeCss(paper, false);
  const dims = PAPER_DIMENSIONS[size.toLowerCase()] ?? (size.split(' ') as [string, string]);
  return landscape ? [dims[1], dims[0]] : dims;
}

/** Screen styles that make the HTML preview look like sheets of paper. */
export function previewCss(options: ConvertOptions): string {
  let width = '210mm';
  let height = '297mm';
  try {
    [width, height] = paperDimensions(options.paper, options.landscape);
  } catch {
    // invalid paper size: keep A4 for the preview, the PDF reports the error
  }
  return `@media screen {
  html { background: var(--preview-bg, #e8eaed); }
  body { margin: 0; padding: 28px 20px 64px; }
  .markdown-body {
    box-sizing: border-box; width: ${width}; min-height: ${height};
    margin: 0 auto; padding: ${options.margin}; background: #fff;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.12), 0 8px 24px rgb(0 0 0 / 0.06);
  }
  .page-break, .document + .document { border-top: 1px dashed #c4c9d0; margin: 2.5em 0; position: relative; }
  .page-break::after { content: 'page break'; position: absolute; left: 50%; top: -0.7em; transform: translateX(-50%);
    background: #fff; padding: 0 0.6em; font: 500 9px/1.4 system-ui, sans-serif; letter-spacing: 0.06em; text-transform: uppercase; color: #9aa1ab; }
  .document + .document { padding-top: 2.5em; }
}
@media screen and (prefers-color-scheme: dark) { html { background: var(--preview-bg, #111113); } }
@media screen { body.reflow { padding: 16px 16px 48px; } body.reflow .markdown-body { width: auto; min-height: 0; padding: 32px 36px; } }
`;
}

function pageCss(options: ConvertOptions, theme: ThemeDef, values: TemplateValues): string {
  const boxes: string[] = [];
  const style = `font-family: ${theme.marginFont}; font-size: 8pt; color: #8b949e;`;
  const add = (pos: string, tpl: string | undefined, align: string) => {
    if (tpl === undefined || tpl === '') return;
    boxes.push(`  @${pos} { content: ${templateContent(tpl, values)}; ${style} text-align: ${align}; }`);
  };
  const header = splitTemplate(options.header);
  const footer = splitTemplate(options.footer);
  add('top-left', header.left, 'left');
  add('top-center', header.center, 'center');
  add('top-right', header.right, 'right');
  add('bottom-left', footer.left, 'left');
  add('bottom-center', footer.center, 'center');
  add('bottom-right', footer.right, 'right');
  return `@page {\n  size: ${pageSizeCss(options.paper, options.landscape)};\n  margin: ${options.margin};\n${boxes.join('\n')}\n}\n`;
}

/** Is `theme` a built-in theme name? Otherwise it must be a CSS file path. */
export function resolveTheme(theme: string, baseDir: string): { def: ThemeDef; name: string; file: string | null } {
  if (THEMES[theme]) return { def: THEMES[theme], name: theme, file: null };
  const path = resolve(baseDir, theme);
  if (!existsSync(path)) {
    throw new Error(`Unknown theme "${theme}". Built-in themes: ${themeNames().join(', ')}; or pass a path to a .css file.`);
  }
  return { def: THEMES['default']!, name: 'custom', file: path };
}

const themeCssCache = new Map<string, string>();

function builtinCss(name: string, def: ThemeDef, resolver: AssetResolver, cacheKey: string): string {
  const key = `${name}\0${cacheKey}`;
  let css = themeCssCache.get(key);
  if (css === undefined) {
    const fonts = def.fonts.map((f) => fontFaceCss(f, resolver)).join('\n');
    const base = readCached(resolve(THEMES_DIR, 'base.css'));
    const themeFile = resolve(THEMES_DIR, `${name}.css`);
    const theme = name !== 'custom' && existsSync(themeFile) ? readCached(themeFile) : '';
    css = `${fonts}\n${base}\n${theme}`;
    themeCssCache.set(key, css);
  }
  return css;
}

export interface BuildInput {
  title: string;
  body: string;
  options: ConvertOptions;
  features: { math: boolean; mermaid: boolean };
  resolver: AssetResolver;
  /** Cache key distinguishing resolvers (file:// vs http). */
  resolverKey: string;
  /** Directory relative theme/css paths are resolved against. */
  baseDir: string;
  templateValues: TemplateValues;
  bodyClass?: string[];
  /** Extra script injected for the web preview. */
  extraHead?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const READY_SCRIPT = `
(function () {
  var warnings = [];
  function imagesSettled() {
    return Promise.all(Array.prototype.map.call(document.images, function (img) {
      if (img.complete) return null;
      return new Promise(function (r) { img.addEventListener('load', r); img.addEventListener('error', r); });
    })).then(function () {
      Array.prototype.forEach.call(document.images, function (img) {
        if (img.getAttribute('src') && !img.naturalWidth) warnings.push('Image failed to load: ' + decodeURI(img.getAttribute('src')));
      });
    });
  }
  async function diagrams() {
    var nodes = document.querySelectorAll('pre.mermaid');
    if (!nodes.length || !window.mermaid) return;
    var cfg = window.__mdpdfMermaid || {};
    window.mermaid.initialize(Object.assign({ startOnLoad: false, securityLevel: 'loose' }, cfg));
    for (var i = 0; i < nodes.length; i++) {
      try {
        // Validate first so invalid diagrams keep their source instead of
        // Mermaid's error graphic.
        nodes[i].setAttribute('data-source', nodes[i].textContent);
        await window.mermaid.parse(nodes[i].textContent);
        await window.mermaid.run({ nodes: [nodes[i]] });
      } catch (e) {
        var box = nodes[i].closest('.mermaid-diagram');
        if (box) box.classList.add('mermaid-error');
        nodes[i].setAttribute('data-processed', 'error');
        warnings.push('Mermaid diagram ' + (i + 1) + ': ' + String(e && e.message || e).split('\\n')[0]);
      }
    }
  }
  window.__mdpdfReady = Promise.all([imagesSettled(), diagrams()])
    .then(function () { return document.fonts.ready; })
    .then(function () { return warnings; });
})();
`;

export function buildHtml(input: BuildInput): string {
  const { options, resolver, features } = input;
  const theme = resolveTheme(options.theme, input.baseDir);
  const links: string[] = [];
  let css = builtinCss(theme.name, theme.def, resolver, input.resolverKey);
  if (theme.file) links.push(theme.file);
  for (const extra of options.css) {
    const path = resolve(input.baseDir, extra);
    if (!existsSync(path)) throw new Error(`Stylesheet not found: ${extra}`);
    links.push(path);
  }
  const overrides: string[] = [];
  if (options.fontSize) overrides.push(`:root { --font-size: ${options.fontSize}; }`);
  css += '\n' + pageCss(options, theme.def, input.templateValues) + overrides.join('\n');

  const head: string[] = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.title)}</title>`,
  ];
  if (input.options.author) head.push(`<meta name="author" content="${escapeHtml(input.options.author)}">`);
  if (features.math) head.push(`<link rel="stylesheet" href="${escapeHtml(resolver.file(resolvePackageFile('katex/dist/katex.min.css')))}">`);
  head.push(`<style>\n${css}\n</style>`);
  for (const link of links) head.push(`<link rel="stylesheet" href="${escapeHtml(resolver.file(link))}">`);
  if (input.extraHead) head.push(input.extraHead);

  const scripts: string[] = [];
  if (features.mermaid) {
    const fontFamily = theme.def.marginFont.split(',')[0]!.replace(/'/g, '');
    const auto = options.mermaidTheme === 'auto';
    const config = {
      theme: auto ? 'base' : options.mermaidTheme,
      themeVariables: auto ? { ...theme.def.mermaid, fontFamily: `${fontFamily}, sans-serif` } : { fontFamily: `${fontFamily}, sans-serif` },
      fontFamily: `${fontFamily}, sans-serif`,
      // Natural size; CSS caps diagrams at the page width.
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
      journey: { useMaxWidth: false },
      pie: { useMaxWidth: false },
      gitGraph: { useMaxWidth: false },
      mindmap: { useMaxWidth: false },
      timeline: { useMaxWidth: false },
    };
    scripts.push(`<script>window.__mdpdfMermaid = ${JSON.stringify(config)};</script>`);
    scripts.push(`<script src="${escapeHtml(resolver.file(resolvePackageFile('mermaid/dist/mermaid.min.js')))}"></script>`);
  }
  scripts.push(`<script>${READY_SCRIPT}</script>`);

  const bodyClass = [`theme-${theme.name}`, ...(input.bodyClass ?? [])];
  if (options.breakBefore !== 'none') bodyClass.push(`break-${options.breakBefore}`);

  return (
    `<!doctype html>\n<html lang="${escapeHtml(options.lang || 'en')}">\n<head>\n${head.join('\n')}\n</head>\n` +
    `<body class="${bodyClass.join(' ')}">\n<article class="markdown-body">\n${input.body}\n</article>\n${scripts.join('\n')}\n</body>\n</html>\n`
  );
}
