/**
 * Markdown → HTML.
 *
 * Rendering is split into three steps so that heavy dependencies load only
 * when needed, while markdown-it's renderer stays synchronous:
 *
 *   1. parse        markdown-it tokens (sync)
 *   2. prepare      walk tokens: resolve and parse embedded notes, collect
 *                   code languages and math usage, then load just those
 *                   Shiki grammars / KaTeX (async)
 *   3. render       tokens → HTML (sync)
 */
import GithubSlugger from 'github-slugger';
import MarkdownIt, { type MarkdownIt as Md, type Token } from 'markdown-it';
import abbr from 'markdown-it-abbr';
import deflist from 'markdown-it-deflist';
import footnote from 'markdown-it-footnote';
import mark from 'markdown-it-mark';
import { readFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { trace } from '../debug.ts';
import type { Vault } from '../vault.ts';
import { splitFrontmatter } from './frontmatter.ts';
import { prepareHighlighter } from './highlight.ts';
import { loadKatex } from './math.ts';
import { blocksPlugin, TOC_PLACEHOLDER } from './plugins/blocks.ts';
import { calloutsPlugin } from './plugins/callouts.ts';
import { emojiPlugin } from './plugins/emoji.ts';
import { mathPlugin } from './plugins/math.ts';
import { obsidianPlugin, type WikiTarget } from './plugins/obsidian.ts';
import { strikethroughPlugin } from './plugins/strikethrough.ts';
import { headingId, IMAGE_EXTS, inlineText, installRenderRules, isMarkdownPath, type ResolvedEmbed } from './render-rules.ts';
import { renderToc } from './toc.ts';
import type { AssetResolver, Heading, MarkdownOptions, RenderContext, RenderEnv } from './types.ts';

export type { AssetResolver, Heading, MarkdownOptions, RenderContext } from './types.ts';

const MAX_EMBED_DEPTH = 8;
const LINKISH_RE = /www\.|:\/\/|@/;

let instance: Md | null = null;

export function getMarkdown(): Md {
  if (instance) return instance;
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });
  md.linkify.set({ fuzzyLink: true, fuzzyEmail: true });
  md.core.ruler.after('linkify', 'linkify_gfm', linkifyGfm);
  // Local documents may legitimately link to file: URLs; only block script URLs.
  md.validateLink = (url) => !/^\s*(javascript|vbscript):/i.test(url);
  md.use(strikethroughPlugin)
    .use(obsidianPlugin)
    .use(calloutsPlugin)
    .use(mathPlugin)
    .use(blocksPlugin)
    .use(footnote)
    .use(deflist)
    .use(abbr)
    .use(mark)
    .use(emojiPlugin);
  installRenderRules(md);
  instance = md;
  return md;
}

/**
 * GitHub only autolinks URLs with a scheme, "www." prefixes and emails, not
 * bare domains like "example.com". linkify-it's fuzzy mode finds both, so
 * undo the bare-domain matches.
 */
function linkifyGfm(state: { tokens: Token[] }): void {
  for (const block of state.tokens) {
    const children = block.children;
    if (block.type !== 'inline' || !children) continue;
    for (let i = 0; i < children.length; i++) {
      const open = children[i]!;
      if (open.type !== 'link_open' || open.markup !== 'linkify') continue;
      const text = children[i + 1];
      const close = children[i + 2];
      if (!text || text.type !== 'text' || close?.type !== 'link_close') continue;
      if (/^(?:[a-z][a-z0-9+.-]*:|www\.)/i.test(text.content) || text.content.includes('@')) continue;
      // Merge back into the surrounding text.
      children.splice(i, 3, text);
      text.markup = '';
    }
  }
}

const sourceLine = new WeakMap<Token, number>();
let lineRulesInstalled = false;

/**
 * Tag top-level blocks with their source line. Tokens rendered by the default
 * renderer get a data-line attribute; for custom rules the attribute is
 * spliced into the first tag of their output.
 */
function annotateLines(md: Md, tokens: Token[], offset: number): void {
  if (!lineRulesInstalled) {
    lineRulesInstalled = true;
    const rules = md.renderer.rules;
    for (const [type, rule] of Object.entries(rules)) {
      if (!rule) continue;
      rules[type] = (toks, idx, options, env, self) => {
        const out = rule(toks, idx, options, env, self);
        const line = sourceLine.get(toks[idx]!);
        return line === undefined ? out : out.replace(/^(\s*<[a-zA-Z][\w-]*)/, `$1 data-line="${line}"`);
      };
    }
  }
  for (const token of tokens) {
    if (token.level !== 0 || !token.map || token.nesting === -1) continue;
    const line = token.map[0] + offset;
    if (md.renderer.rules[token.type]) sourceLine.set(token, line);
    else token.attrSet('data-line', String(line));
  }
}

export interface ContextInit {
  options: MarkdownOptions;
  resolver: AssetResolver;
  vault: Vault;
  linkTarget?: (absPath: string) => string | null;
  sourceLines?: boolean;
}

export function createContext(init: ContextInit): RenderContext {
  return {
    options: init.options,
    resolver: init.resolver,
    vault: init.vault,
    linkTarget: init.linkTarget,
    deps: new Set(),
    features: { math: false, mermaid: false },
    warnings: [],
    headings: [],
    slugger: new GithubSlugger(),
    docAnchors: new Map(),
    katexMacros: {},
    docCounter: 0,
    sourceLines: init.sourceLines ?? false,
    lineOffset: 0,
  };
}

function newEnv(ctx: RenderContext, file: string | undefined, dir: string, depth: number, stack: string[]): RenderEnv {
  return { ctx, file, dir, docId: `d${++ctx.docCounter}`, depth, stack };
}

/** Tokens of the section under a heading (until the next heading of the same or higher level). */
function sliceSection(tokens: Token[], subpath: string): Token[] | null {
  const footStart = tokens.findIndex((t) => t.type === 'footnote_block_open');
  const body = footStart === -1 ? tokens : tokens.slice(0, footStart);
  const footer = footStart === -1 ? [] : tokens.slice(footStart);
  if (subpath.startsWith('^')) {
    const idx = body.findIndex((t) => t.nesting !== -1 && t.attrGet('id') === subpath);
    if (idx === -1) return null;
    const open = body[idx]!;
    if (open.nesting === 0) return [open, ...footer];
    const closeType = open.type.replace(/_open$/, '_close');
    let end = idx + 1;
    while (end < body.length && !(body[end]!.type === closeType && body[end]!.level === open.level)) end++;
    let slice = body.slice(idx, end + 1);
    // A list item on its own renders as its content.
    if (open.type === 'list_item_open') slice = slice.slice(1, -1);
    return [...slice, ...footer];
  }
  const wanted = headingId(subpath);
  const start = body.findIndex(
    (t, i) => t.type === 'heading_open' && headingId(inlineText(body[i + 1]?.children ?? null)) === wanted,
  );
  if (start === -1) return null;
  const level = Number(body[start]!.tag.slice(1));
  let end = start + 1;
  while (end < body.length) {
    const t = body[end]!;
    if (t.type === 'heading_open' && t.level === body[start]!.level && Number(t.tag.slice(1)) <= level) break;
    end++;
  }
  return [...body.slice(start, end), ...footer];
}

interface Collected {
  langs: Set<string>;
  math: boolean;
  mhchem: boolean;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Walk tokens: resolve embeds (recursively) and record what needs loading. */
function collect(tokens: Token[], env: RenderEnv, out: Collected): void {
  const md = getMarkdown();
  const { ctx } = env;
  for (const token of tokens) {
    switch (token.type) {
      case 'fence': {
        const lang = token.info.trim().split(/\s+/)[0]!.toLowerCase();
        if (lang === 'mermaid') ctx.features.mermaid = true;
        else if (lang === 'math' || lang === 'latex-math') {
          out.math = true;
          if (/\\(ce|pu)\{/.test(token.content)) out.mhchem = true;
        } else if (lang) out.langs.add(lang);
        break;
      }
      case 'math_block':
      case 'math_inline':
      case 'math_inline_display':
        out.math = true;
        if (/\\(ce|pu)\{/.test(token.content)) out.mhchem = true;
        break;
      case 'wiki_embed':
      case 'wiki_embed_block':
        resolveEmbed(token, env, out, md);
        break;
    }
    if (token.children) collect(token.children, env, out);
  }
}

function resolveEmbed(token: Token, env: RenderEnv, out: Collected, md: Md): void {
  const target = token.meta as unknown as WikiTarget & { resolved?: ResolvedEmbed };
  const { ctx } = env;
  if (!target.path) {
    // ![[#Heading]] embeds a section of the current note.
    if (!env.file) {
      target.resolved = { kind: 'missing' };
      return;
    }
  }
  const abs = target.path ? ctx.vault.resolveLink(target.path, env.dir) : env.file!;
  if (!abs) {
    target.resolved = { kind: 'missing' };
    ctx.warnings.push(`Embedded file not found: ${target.path}${env.file ? ` (in ${env.file})` : ''}`);
    return;
  }
  ctx.deps.add(abs);
  const ext = extname(abs).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    target.resolved = { kind: 'image', abs };
    return;
  }
  if (!isMarkdownPath(abs)) {
    target.resolved = { kind: 'file', abs };
    return;
  }
  if (env.stack.includes(abs) && !target.subpath) {
    target.resolved = { kind: 'cycle', abs };
    ctx.warnings.push(`Skipped recursive embed of ${target.path}`);
    return;
  }
  if (env.depth >= MAX_EMBED_DEPTH) {
    target.resolved = { kind: 'cycle', abs };
    return;
  }
  const raw = readText(abs);
  if (raw === null) {
    target.resolved = { kind: 'missing' };
    return;
  }
  const childEnv = newEnv(ctx, abs, dirname(abs), env.depth + 1, [...env.stack, abs]);
  let tokens = parse(md, splitFrontmatter(raw).body, childEnv);
  if (target.subpath) {
    const section = sliceSection(tokens, target.subpath);
    if (!section) {
      target.resolved = { kind: 'missing' };
      ctx.warnings.push(`Section "${target.subpath}" not found in ${abs}`);
      return;
    }
    tokens = section;
  }
  collect(tokens, childEnv, out);
  target.resolved = { kind: 'markdown', abs, tokens, env: childEnv };
}

function parse(md: Md, body: string, env: RenderEnv): Token[] {
  // linkify-it is relatively costly to warm up; skip it when nothing could match.
  md.set({ linkify: LINKISH_RE.test(body) });
  return md.parse(body, env);
}

export interface RenderedMarkdown {
  html: string;
  headings: Heading[];
}

/**
 * Render one markdown document (front matter already removed) into `ctx`.
 * Several documents may share one context when merged into a single PDF.
 */
export async function renderMarkdown(body: string, ctx: RenderContext, file?: string, dir?: string): Promise<RenderedMarkdown> {
  const md = getMarkdown();
  const baseDir = dir ?? (file ? dirname(file) : process.cwd());
  const env = newEnv(ctx, file, baseDir, 0, file ? [file] : []);
  if (file) ctx.deps.add(file);
  let t = trace('markdown: start');
  const tokens = parse(md, body, env);
  t = trace('markdown: parsed', t);

  const collected: Collected = { langs: new Set(), math: false, mhchem: false };
  collect(tokens, env, collected);
  if (collected.math) ctx.features.math = true;
  await Promise.all([
    prepareHighlighter(collected.langs, ctx.options.codeTheme),
    collected.math ? loadKatex(collected.mhchem) : null,
  ]);
  t = trace(`markdown: prepared (${[...collected.langs].join(', ') || 'no code'}${collected.math ? ', math' : ''})`, t);

  if (ctx.sourceLines) annotateLines(md, tokens, ctx.lineOffset);
  const headingStart = ctx.headings.length;
  let html = md.renderer.render(tokens, { ...md.options, breaks: ctx.options.breaks }, env);
  if (html.includes(TOC_PLACEHOLDER)) {
    html = html.replaceAll(TOC_PLACEHOLDER, renderToc(ctx.headings.slice(headingStart), ctx.options.tocDepth, false));
  }
  trace('markdown: rendered', t);
  return { html, headings: ctx.headings.slice(headingStart) };
}
