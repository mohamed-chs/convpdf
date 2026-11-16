/**
 * Renderer overrides: headings (ids + TOC collection), links and images
 * (local path resolution), code fences (Shiki, Mermaid, math), raw HTML
 * (relative URL rewriting), wikilinks and embeds, footnote tweaks.
 */
import { slug } from 'github-slugger';
import type { MarkdownIt, RendererRule, Token } from 'markdown-it';
import { extname } from 'node:path';
import { highlight, plainLines } from './highlight.ts';
import { renderMath } from './math.ts';
import type { WikiTarget } from './plugins/obsidian.ts';
import { isEnv, type RenderEnv } from './types.ts';

type Options = MarkdownIt['options'];

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.avif', '.ico', '.tif', '.tiff']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.3gp', '.flac', '.webm']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.ogv', '.mov', '.mkv']);
const MD_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd']);

export function isMarkdownPath(path: string): boolean {
  return MD_EXTS.has(extname(path).toLowerCase());
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function isExternalUrl(url: string): boolean {
  return SCHEME_RE.test(url) || url.startsWith('//');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function splitUrl(url: string): { path: string; query: string; hash: string } {
  const hashIdx = url.indexOf('#');
  const hash = hashIdx === -1 ? '' : url.slice(hashIdx + 1);
  const beforeHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const qIdx = beforeHash.indexOf('?');
  return {
    path: qIdx === -1 ? beforeHash : beforeHash.slice(0, qIdx),
    query: qIdx === -1 ? '' : beforeHash.slice(qIdx),
    hash,
  };
}

/** Resolve an image (or other embedded asset) URL. */
export function resolveAsset(url: string, env: RenderEnv): string {
  if (!url || isExternalUrl(url) || url.startsWith('#')) return url;
  const { path, query, hash } = splitUrl(url);
  const decoded = safeDecode(path);
  const abs = env.ctx.vault.resolvePath(decoded, env.dir);
  if (abs) {
    env.ctx.deps.add(abs);
    // Keep the fragment: SVG views, and GitHub's #gh-dark-mode-only marker.
    return env.ctx.resolver.file(abs) + query + (hash ? `#${hash}` : '');
  }
  env.ctx.warnings.push(`Image not found: ${decoded}${env.file ? ` (in ${env.file})` : ''}`);
  return url;
}

/** Turn a heading-ish string into the id GitHub would give it. */
export function headingId(text: string): string {
  return slug(text.trim());
}

/**
 * A link to a heading in `file` (or a block id). Heading ids are final only
 * after rendering, so this returns a placeholder that resolveHeadingRefs()
 * replaces; `fallback` is used when no heading matches.
 */
function headingRef(env: RenderEnv, file: string | undefined, fragment: string, fallback: string): string {
  if (!fragment || fragment.startsWith('^')) return fallback;
  const n = env.ctx.refs.push({ file: file ?? '', fragment, fallback }) - 1;
  return `#convpdf-ref-${n}`;
}

/** Fragment for a link into another PDF: the GitHub-style id of the heading. */
function externalFragment(fragment: string): string {
  if (fragment.startsWith('^')) return fragment;
  return headingId(safeDecode(fragment).split('#').pop()!) || fragment;
}

/** href for a link to a local markdown/other file (+ optional fragment). */
function localHref(abs: string, fragment: string, env: RenderEnv): string | null {
  const { ctx } = env;
  // Block ids (^id) are matched as written; markdown-it percent-encodes the caret.
  const block = safeDecode(fragment).startsWith('^') ? `#${safeDecode(fragment)}` : null;
  if (env.file && abs === env.file && env.depth === 0) return fragment ? (block ?? headingRef(env, abs, fragment, `#${fragment}`)) : null;
  if (isMarkdownPath(abs)) {
    const target = ctx.linkTarget?.(abs);
    if (target) {
      if (target.startsWith('#')) return fragment ? (block ?? headingRef(env, abs, fragment, target)) : target;
      return fragment ? `${target}#${externalFragment(fragment)}` : target;
    }
  }
  return ctx.resolver.file(abs) + (fragment ? `#${fragment}` : '');
}

/** Resolve a markdown link href. */
export function resolveLink(href: string, env: RenderEnv): string {
  if (href.length > 1 && href.startsWith('#')) {
    const fragment = safeDecode(href.slice(1));
    return fragment.startsWith('^') ? `#${fragment}` : headingRef(env, env.file, href.slice(1), href);
  }
  if (!href || href.startsWith('#') || isExternalUrl(href)) return href;
  const { path, query, hash } = splitUrl(href);
  if (!path) return href;
  const decoded = safeDecode(path);
  const abs = env.ctx.vault.resolvePath(decoded, env.dir);
  if (!abs) return href;
  const out = localHref(abs, hash, env);
  return out === null ? '#' : out + (out.startsWith('#') ? '' : query);
}

function wikiHref(target: WikiTarget, env: RenderEnv): string | null | undefined {
  const sub = target.subpath;
  const local = sub ? `#${sub.startsWith('^') ? sub : headingId(sub.split('#').pop()!)}` : '';
  if (!target.path) return sub ? headingRef(env, env.file, sub, local) : null;
  const abs = env.ctx.vault.resolveLink(target.path, env.dir);
  if (!abs) return undefined; // unresolved
  if (isMarkdownPath(abs)) {
    if (env.file && abs === env.file) return sub ? headingRef(env, abs, sub, local) : null;
    const t = env.ctx.linkTarget?.(abs);
    if (!t) return null; // a note that is not part of this PDF
    if (t.startsWith('#')) return sub ? headingRef(env, abs, sub, sub.startsWith('^') ? local : t) : t;
    return sub ? `${t}${local}` : t;
  }
  return env.ctx.resolver.file(abs);
}

function wikiDisplay(target: WikiTarget): string {
  if (target.alias) return target.alias;
  const sub = target.subpath.replace(/^\^/, '');
  if (!target.path) return sub;
  return sub ? `${target.path} › ${sub}` : target.path;
}

/** Plain text of a heading's inline content, for ids and the TOC. */
export function inlineText(tokens: Token[] | null): string {
  if (!tokens) return '';
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
      case 'code_inline':
      case 'math_inline':
        out += t.content;
        break;
      case 'emoji':
        out += t.content;
        break;
      case 'tag':
        out += '#' + t.content;
        break;
      case 'wikilink':
        out += wikiDisplay(t.meta as unknown as WikiTarget);
        break;
      case 'image':
        out += inlineText(t.children);
        break;
      case 'softbreak':
      case 'hardbreak':
        out += ' ';
        break;
      default:
        if (t.children) out += inlineText(t.children);
    }
  }
  return out;
}

const SIZE_RE = /^(\d+)(?:x(\d+))?$/;

function sizeAttrs(spec: string | null | undefined): { attrs: string; alt: string | null } {
  if (!spec) return { attrs: '', alt: null };
  const direct = SIZE_RE.exec(spec.trim());
  if (direct) return { attrs: ` width="${direct[1]}"${direct[2] ? ` height="${direct[2]}"` : ''}`, alt: null };
  // "alt text|300"
  const m = /^(.*?)\s*\|\s*(\d+)(?:x(\d+))?\s*$/.exec(spec);
  if (m) return { attrs: ` width="${m[2]}"${m[3] ? ` height="${m[3]}"` : ''}`, alt: m[1]! };
  return { attrs: '', alt: spec };
}

const HTML_URL_ATTR_RE = /(\s(src|href|poster|srcset)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;

/** `srcset="a.png 1x, b.png 2x"`: resolve each candidate URL. */
function resolveSrcset(value: string, env: RenderEnv): string {
  return value
    .split(',')
    .map((candidate) => {
      const m = /^(\s*)(\S+)(.*)$/s.exec(candidate);
      return m ? m[1]! + resolveAsset(m[2]!, env) + m[3]! : candidate;
    })
    .join(',');
}

function rewriteHtml(html: string, env: RenderEnv): string {
  let out = html.replace(HTML_URL_ATTR_RE, (whole, prefix: string, attr: string, dq?: string, sq?: string) => {
    const value = dq ?? sq ?? '';
    const name = attr.toLowerCase();
    const resolved = name === 'href' ? resolveLink(value, env) : name === 'srcset' ? resolveSrcset(value, env) : resolveAsset(value, env);
    return resolved === value ? whole : `${prefix}"${escapeHtml(resolved)}"`;
  });
  // <meta http-equiv="refresh"> would navigate away from the document.
  out = out.replace(/<meta\b[^>]*>/gi, '');
  // A PDF cannot be clicked open: show <details> expanded.
  out = out.replace(/<details(?![^>]*\sopen)(\s|>)/gi, '<details open$1');
  return out;
}

export interface ResolvedEmbed {
  kind: 'markdown' | 'image' | 'file' | 'missing' | 'cycle';
  abs?: string;
  tokens?: Token[];
  env?: RenderEnv;
}

function renderEmbed(token: Token, options: Options, env: RenderEnv, md: MarkdownIt): string {
  const target = token.meta as unknown as WikiTarget & { resolved?: ResolvedEmbed };
  const resolved = target.resolved;
  const label = escapeHtml(target.path + (target.subpath ? `#${target.subpath}` : ''));
  if (!resolved || resolved.kind === 'missing') {
    return `<span class="embed-missing">${label}</span>`;
  }
  if (resolved.kind === 'cycle') return `<span class="embed-missing embed-cycle">${label}</span>`;
  const abs = resolved.abs!;
  if (resolved.kind === 'image') {
    const { attrs, alt } = sizeAttrs(target.alias);
    const src = env.ctx.resolver.file(abs);
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt ?? target.path)}"${attrs} class="embed-image">`;
  }
  if (resolved.kind === 'markdown' && resolved.tokens && resolved.env) {
    const body = md.renderer.render(resolved.tokens, options, resolved.env);
    return `<div class="markdown-embed" data-embed="${label}">\n${body}</div>\n`;
  }
  const ext = extname(abs).toLowerCase();
  const kind = AUDIO_EXTS.has(ext) ? 'audio' : VIDEO_EXTS.has(ext) ? 'video' : ext === '.pdf' ? 'pdf' : 'file';
  const name = escapeHtml(target.alias || target.path);
  return `<a class="file-embed" data-kind="${kind}" href="${escapeHtml(env.ctx.resolver.file(abs))}">${name}</a>`;
}

export function installRenderRules(md: MarkdownIt): void {
  const rules = md.renderer.rules;
  const defaultRender: RendererRule = (tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options);

  rules.heading_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    if (isEnv(env)) {
      const text = inlineText(tokens[idx + 1]?.children ?? null).trim();
      let id = token.attrGet('id') as string | null;
      if (!id) {
        id = env.ctx.slugger.slug(text) || `section-${env.ctx.headings.length + 1}`;
        token.attrSet('id', id);
      }
      env.ctx.headings.push({ level: Number(token.tag.slice(1)), text, id, file: env.file ?? '', embedded: env.depth > 0 });
    }
    return self.renderToken(tokens, idx, options);
  };

  const linkOpen = rules.link_open ?? defaultRender;
  rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const href = token.attrGet('href') as string | null;
    if (href && isEnv(env)) {
      const resolved = resolveLink(href, env);
      if (resolved !== href) token.attrSet('href', resolved);
    }
    return linkOpen(tokens, idx, options, env, self);
  };

  rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    let src = (token.attrGet('src') as string | null) ?? '';
    let alt = self.renderInlineAsText(token.children ?? [], options, env);
    let size = '';
    const sized = /^(.*?)\s*\|\s*(\d+)(?:x(\d+))?\s*$/.exec(alt);
    if (sized) {
      alt = sized[1]!;
      size = ` width="${sized[2]}"${sized[3] ? ` height="${sized[3]}"` : ''}`;
    }
    if (isEnv(env)) src = resolveAsset(src, env);
    const title = token.attrGet('title');
    const extra = token.attrs
      ?.filter(([k]) => !['src', 'alt', 'title'].includes(k))
      .map(([k, v]) => ` ${k}="${escapeHtml(String(v))}"`)
      .join('') ?? '';
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(String(title))}"` : ''}${size}${extra}>`;
  };

  rules.fence = (tokens, idx, _options, env) => {
    const token = tokens[idx]!;
    const info = token.info ? md.utils.unescapeAll(token.info).trim() : '';
    const space = info.search(/\s/);
    const lang = space === -1 ? info : info.slice(0, space);
    const meta = space === -1 ? '' : info.slice(space + 1);
    const lower = lang.toLowerCase();
    const id = token.attrGet('id');
    const idAttr = id ? ` id="${escapeHtml(String(id))}"` : '';
    const code = token.content;

    if (lower === 'mermaid') {
      return `<div class="mermaid-diagram"${idAttr}><pre class="mermaid">${escapeHtml(code)}</pre></div>\n`;
    }
    if (lower === 'math' || lower === 'latex-math') {
      const macros = isEnv(env) ? env.ctx.katexMacros : {};
      return `<div class="math-block"${idAttr}>${renderMath(code.trim(), true, macros)}</div>\n`;
    }

    const theme = isEnv(env) ? env.ctx.options.codeTheme : 'github-light';
    const body = code.replace(/\n$/, '');
    let lines = highlight(body, lang, theme) ?? plainLines(body);
    if (lower === 'diff' || lower === 'patch') {
      const src = body.split('\n');
      let i = 0;
      lines = lines.replace(/<span class="line">/g, () => {
        const c = src[i++]?.charAt(0);
        const cls = c === '+' ? ' diff-add' : c === '-' ? ' diff-remove' : '';
        return `<span class="line${cls}">`;
      });
    }
    const titleMatch = /(?:title|filename)=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta);
    const title = titleMatch ? (titleMatch[1] ?? titleMatch[2] ?? titleMatch[3]) : '';
    const numbered = isEnv(env) && env.ctx.options.lineNumbers ? ' line-numbers' : '';
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    return (
      `<div class="code-block${numbered}"${idAttr}>` +
      (title ? `<div class="code-title">${escapeHtml(title)}</div>` : '') +
      `<pre${langAttr}><code>${lines}</code></pre></div>\n`
    );
  };

  rules.code_block = (tokens, idx, _options, env) => {
    const numbered = isEnv(env) && env.ctx.options.lineNumbers ? ' line-numbers' : '';
    return `<div class="code-block${numbered}"><pre><code>${plainLines(tokens[idx]!.content.replace(/\n$/, ''))}</code></pre></div>\n`;
  };

  rules.html_block = (tokens, idx, _options, env) =>
    isEnv(env) ? rewriteHtml(tokens[idx]!.content, env) : tokens[idx]!.content;
  rules.html_inline = (tokens, idx, _options, env) =>
    isEnv(env) ? rewriteHtml(tokens[idx]!.content, env) : tokens[idx]!.content;

  rules['wikilink'] = (tokens, idx, _options, env) => {
    const target = tokens[idx]!.meta as unknown as WikiTarget;
    const text = escapeHtml(wikiDisplay(target));
    if (!isEnv(env)) return `<span class="internal-link">${text}</span>`;
    const href = wikiHref(target, env);
    if (href === undefined) return `<span class="internal-link is-unresolved">${text}</span>`;
    if (href === null) return `<span class="internal-link">${text}</span>`;
    return `<a class="internal-link" href="${escapeHtml(href)}">${text}</a>`;
  };

  rules['wiki_embed'] = (tokens, idx, options, env) => (isEnv(env) ? renderEmbed(tokens[idx]!, options, env, md) : '');
  rules['wiki_embed_block'] = (tokens, idx, options, env) => {
    if (!isEnv(env)) return '';
    const html = renderEmbed(tokens[idx]!, options, env, md);
    if (html.startsWith('<div')) return html;
    return html.startsWith('<img') ? `<p class="image-paragraph">${html}</p>\n` : `<p>${html}</p>\n`;
  };

  // Footnotes: plain numbers, no "[1]" brackets, no separator rule.
  rules['footnote_caption'] = (tokens, idx) => {
    const meta = tokens[idx]!.meta as { id: number; subId: number };
    return `${meta.id + 1}`;
  };
  rules['footnote_block_open'] = () => '<section class="footnotes">\n<ol class="footnotes-list">\n';
  rules['footnote_block_close'] = () => '</ol>\n</section>\n';
}
