/**
 * Obsidian syntax: [[wikilinks]], ![[embeds]], %%comments%%, #tags and ^block-ids.
 *
 * Parsing only happens here; resolving targets and rendering live in
 * render-rules.ts / prepare.ts because they need file system access.
 */
import type { MarkdownIt, StateBlock, StateCore, StateInline, Token } from 'markdown-it';

export type WikiTarget = {
  /** File part, e.g. "folder/Note" (may be empty for same-note links). */
  path: string;
  /** Heading path or block reference after '#', e.g. "Heading" or "^abc". */
  subpath: string;
  /** Text after '|' (display text, or image size for embeds). */
  alias: string | null;
};

export function parseWikiTarget(inner: string): WikiTarget {
  const text = inner.replace(/\\\|/g, '|');
  const pipe = text.indexOf('|');
  const link = pipe === -1 ? text : text.slice(0, pipe);
  const alias = pipe === -1 ? null : text.slice(pipe + 1).trim();
  const hash = link.indexOf('#');
  const path = (hash === -1 ? link : link.slice(0, hash)).trim();
  // Nested heading paths (Note#H1#H2) target the last heading.
  const subpath = hash === -1 ? '' : (link.slice(hash + 1).split('#').filter(Boolean).pop() ?? '').trim();
  return { path, subpath, alias };
}

function wikilinkInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  let pos = state.pos;
  let embed = false;
  if (src.charCodeAt(pos) === 0x21 /* ! */) {
    embed = true;
    pos++;
  }
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf(']]', pos + 2);
  if (end === -1) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner.trim() || inner.includes('\n') || inner.includes('[[')) return false;
  if (!silent) {
    const token = state.push(embed ? 'wiki_embed' : 'wikilink', '', 0);
    token.content = inner;
    token.meta = parseWikiTarget(inner);
  }
  state.pos = end + 2;
  return true;
}

/** A line containing only `![[target]]` becomes a block-level embed. */
function wikiEmbedBlock(state: StateBlock, startLine: number, _endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine]! + state.tShift[startLine]!;
  const max = state.eMarks[startLine]!;
  const line = state.src.slice(start, max);
  const m = /^!\[\[([^\]\n]+)\]\][ \t]*$/.exec(line);
  if (!m) return false;
  if (silent) return true;
  const token = state.push('wiki_embed_block', 'div', 0);
  token.content = m[1]!;
  token.meta = parseWikiTarget(m[1]!);
  token.map = [startLine, startLine + 1];
  token.block = true;
  state.line = startLine + 1;
  return true;
}

function commentInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x25 || src.charCodeAt(pos + 1) !== 0x25) return false;
  const end = src.indexOf('%%', pos + 2);
  if (end === -1) return false;
  if (!silent) state.push('comment', '', 0);
  state.pos = end + 2;
  return true;
}

/** `%%` at the start of a line opens a comment that may span blank lines. */
function commentBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine]! + state.tShift[startLine]!;
  const max = state.eMarks[startLine]!;
  if (state.src.charCodeAt(start) !== 0x25 || state.src.charCodeAt(start + 1) !== 0x25) return false;
  const rest = state.src.slice(start + 2, max);
  const closeInFirst = rest.indexOf('%%');
  let closeLine = -1;
  if (closeInFirst !== -1) {
    // Single-line comment: only a block if nothing follows it on the line.
    if (rest.slice(closeInFirst + 2).trim() !== '') return false;
    closeLine = startLine;
  } else {
    for (let line = startLine + 1; line < endLine; line++) {
      const s = state.bMarks[line]! + state.tShift[line]!;
      const e = state.eMarks[line]!;
      const idx = state.src.slice(s, e).indexOf('%%');
      if (idx !== -1) {
        if (state.src.slice(s + idx + 2, e).trim() !== '') return false;
        closeLine = line;
        break;
      }
    }
    // Unclosed: leave the text alone rather than risk hiding content.
    if (closeLine === -1) return false;
  }
  if (silent) return true;
  const token = state.push('comment', '', 0);
  token.map = [startLine, closeLine + 1];
  state.line = closeLine + 1;
  return true;
}

const TAG_RE = /^[\p{L}\p{N}\p{M}_\-/]+/u;

function tagInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x23 /* # */) return false;
  if (pos > 0) {
    const prev = src.charCodeAt(pos - 1);
    if (prev !== 0x20 && prev !== 0x09 && prev !== 0x0a && prev !== 0xa0) return false;
  }
  const m = TAG_RE.exec(src.slice(pos + 1));
  if (!m) return false;
  const tag = m[0].replace(/[/-]+$/, '');
  // Tags need at least one non-numeric character (#1984 is not a tag).
  if (!tag || /^[\d/_-]*$/.test(tag)) return false;
  if (!silent) {
    const token = state.push('tag', '', 0);
    token.content = tag;
  }
  state.pos = pos + 1 + tag.length;
  return true;
}

const BLOCK_ID_RE = /(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/;

/** Find the opening token matching the closing token at `closeIdx`. */
function findOpen(tokens: Token[], closeIdx: number): number {
  const close = tokens[closeIdx]!;
  if (close.nesting === 0) return closeIdx;
  const type = close.type.replace(/_close$/, '_open');
  for (let j = closeIdx - 1; j >= 0; j--) {
    if (tokens[j]!.type === type && tokens[j]!.level === close.level) return j;
  }
  return -1;
}

/**
 * `text ^block-id` assigns an id to the paragraph or list item, and a line
 * containing only `^block-id` assigns it to the preceding block (table,
 * quote, code block...). Runs before inline parsing.
 */
function blockIds(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.type !== 'inline' || !tokens[i - 1] || tokens[i - 1]!.type !== 'paragraph_open') continue;
    const m = BLOCK_ID_RE.exec(tok.content);
    if (!m) continue;
    const id = '^' + m[1];
    const stripped = tok.content.slice(0, m.index).trimEnd();
    if (stripped === '') {
      // Standalone id: attach to the previous block at the same level.
      const prevIdx = i - 2;
      const prev = tokens[prevIdx];
      if (prev && prev.level === tokens[i - 1]!.level) {
        const openIdx = findOpen(tokens, prevIdx);
        if (openIdx !== -1) {
          tokens[openIdx]!.attrSet('id', id);
          tokens.splice(i - 1, 3);
          i -= 2;
          continue;
        }
      }
      tok.content = '';
      tokens[i - 1]!.attrSet('id', id);
      continue;
    }
    tok.content = stripped;
    const li = tokens[i - 2];
    if (li && li.type === 'list_item_open') li.attrSet('id', id);
    else tokens[i - 1]!.attrSet('id', id);
  }
}

export function obsidianPlugin(md: MarkdownIt): void {
  md.inline.ruler.before('link', 'wikilink', wikilinkInline);
  md.inline.ruler.before('link', 'comment', commentInline);
  md.inline.ruler.push('tag', tagInline);
  md.block.ruler.before('fence', 'comment_block', commentBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.block.ruler.before('paragraph', 'wiki_embed_block', wikiEmbedBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.core.ruler.before('inline', 'block_ids', blockIds);
  md.renderer.rules['comment'] = () => '';
  md.renderer.rules['tag'] = (tokens, idx) =>
    `<span class="tag">#${md.utils.escapeHtml(tokens[idx]!.content)}</span>`;
}
