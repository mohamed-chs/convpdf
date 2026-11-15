/**
 * TeX math, as supported by GitHub and Obsidian:
 *
 *   inline   $E = mc^2$   $`E = mc^2`$ (GitHub)   $$x$$ (display, inline position)
 *   block    $$ ... $$ (single or multiple lines)   ```math fences (GitHub)
 *
 * Rendering is done server-side with KaTeX (see ../math.ts), so the PDF
 * needs no JavaScript for formulas.
 */
import type { MarkdownIt, StateBlock, StateInline } from 'markdown-it';
import { renderMath } from '../math.ts';
import { isEnv } from '../types.ts';

function isWs(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** Index of the next unescaped `marker` at or after `from`, or -1. */
function findClosing(src: string, marker: string, from: number, max: number): number {
  let i = from;
  while (i < max) {
    const idx = src.indexOf(marker, i);
    if (idx === -1 || idx >= max) return -1;
    let backslashes = 0;
    for (let j = idx - 1; j >= 0 && src.charCodeAt(j) === 0x5c; j--) backslashes++;
    if (backslashes % 2 === 0) return idx;
    i = idx + 1;
  }
  return -1;
}

function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  const max = state.posMax;
  if (src.charCodeAt(start) !== 0x24 /* $ */) return false;
  let content: string;
  let next: number;
  let display = false;

  if (src.charCodeAt(start + 1) === 0x60 /* ` */) {
    // GitHub: $`...`$
    const end = src.indexOf('`$', start + 2);
    if (end === -1 || end >= max) return false;
    content = src.slice(start + 2, end);
    next = end + 2;
  } else if (src.charCodeAt(start + 1) === 0x24) {
    // $$...$$ inside a paragraph: display math.
    const end = findClosing(src, '$$', start + 2, max);
    if (end === -1) return false;
    content = src.slice(start + 2, end);
    if (!content.trim()) return false;
    next = end + 2;
    display = true;
  } else {
    const first = src.charCodeAt(start + 1);
    if (Number.isNaN(first) || isWs(first)) return false;
    const end = findClosing(src, '$', start + 1, max);
    if (end === -1) return false;
    if (isWs(src.charCodeAt(end - 1))) return false;
    const after = src.charCodeAt(end + 1);
    if (after >= 0x30 && after <= 0x39) return false; // "$5 and $6" style prices
    content = src.slice(start + 1, end);
    next = end + 1;
  }
  if (!silent) {
    const token = state.push(display ? 'math_inline_display' : 'math_inline', 'math', 0);
    token.content = content;
    token.markup = display ? '$$' : '$';
  }
  state.pos = next;
  return true;
}

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  let pos = state.bMarks[startLine]! + state.tShift[startLine]!;
  let max = state.eMarks[startLine]!;
  if (state.src.charCodeAt(pos) !== 0x24 || state.src.charCodeAt(pos + 1) !== 0x24) return false;
  const firstLine = state.src.slice(pos + 2, max);
  const firstTrim = firstLine.trimEnd();
  let content: string;
  let lastLine = startLine;

  if (firstTrim.endsWith('$$') && firstTrim.trim().length > 2) {
    // $$ ... $$ on one line
    const inner = firstTrim.slice(0, -2);
    if (inner.includes('$$')) return false;
    content = inner;
  } else {
    if (firstLine.includes('$$')) return false; // "$$a$$ text": inline display math
    let found = false;
    let tail = '';
    for (let line = startLine + 1; line < endLine; line++) {
      pos = state.bMarks[line]! + state.tShift[line]!;
      max = state.eMarks[line]!;
      if (pos < max && state.sCount[line]! < state.blkIndent) break;
      const text = state.src.slice(pos, max).trimEnd();
      if (text.endsWith('$$')) {
        tail = text.slice(0, -2);
        lastLine = line;
        found = true;
        break;
      }
    }
    if (!found) return false;
    const middle = state.getLines(startLine + 1, lastLine, state.sCount[startLine]!, false);
    content = [firstLine, middle, tail].join('\n');
  }
  if (silent) return true;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = content.trim();
  token.markup = '$$';
  token.map = [startLine, lastLine + 1];
  state.line = lastLine + 1;
  return true;
}

export function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.before('escape', 'math_inline', mathInline);
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  const macros = (env: unknown) => (isEnv(env) ? env.ctx.katexMacros : {});
  md.renderer.rules['math_inline'] = (tokens, idx, _o, env) => renderMath(tokens[idx]!.content, false, macros(env));
  md.renderer.rules['math_inline_display'] = (tokens, idx, _o, env) => renderMath(tokens[idx]!.content, true, macros(env));
  md.renderer.rules['math_block'] = (tokens, idx, _o, env) => {
    const id = tokens[idx]!.attrGet('id');
    return `<div class="math-block"${id ? ` id="${md.utils.escapeHtml(String(id))}"` : ''}>${renderMath(tokens[idx]!.content, true, macros(env))}</div>\n`;
  };
}
