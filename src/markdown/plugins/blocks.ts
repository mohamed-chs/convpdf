/**
 * Small block-level extensions:
 *
 *  - task lists: `- [ ]`, `- [x]`, plus Obsidian's custom statuses (`- [/]`, `- [-]`...)
 *  - table-of-contents markers: `[TOC]`, `[[TOC]]`, `[[_TOC_]]`, `${toc}`
 *  - page breaks: `\pagebreak`, `\newpage`, `<!-- pagebreak -->`
 */
import type { MarkdownIt, StateBlock, StateCore, Token } from 'markdown-it';

const TASK_RE = /^\[([^\]\n])\](?=\s|$)/;

function taskLists(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i]!;
    if (inline.type !== 'inline') continue;
    if (tokens[i - 1]!.type !== 'paragraph_open' || tokens[i - 2]!.type !== 'list_item_open') continue;
    const first = inline.children?.[0];
    if (!first || first.type !== 'text') continue;
    const m = TASK_RE.exec(first.content);
    if (!m) continue;
    const status = m[1]!;
    first.content = first.content.slice(3).replace(/^[ \t]/, '');
    const checkbox = new state.Token('task_checkbox', 'input', 0);
    checkbox.meta = { status };
    inline.children!.unshift(checkbox);

    const li = tokens[i - 2]!;
    li.attrJoin('class', 'task-list-item');
    li.attrSet('data-task', status);
    // Mark the enclosing list.
    for (let j = i - 3; j >= 0; j--) {
      const t = tokens[j]!;
      if ((t.type === 'bullet_list_open' || t.type === 'ordered_list_open') && t.level === li.level - 1) {
        if (!(t.attrGet('class') ?? '').toString().includes('contains-task-list')) t.attrJoin('class', 'contains-task-list');
        break;
      }
    }
  }
}

/** Mark paragraphs that contain nothing but one image (optionally linked), so themes can center them. */
function imageParagraphs(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i]!.type !== 'paragraph_open' || tokens[i + 1]!.type !== 'inline') continue;
    const kids = (tokens[i + 1]!.children ?? []).filter(
      (t) => !(t.type === 'softbreak' || (t.type === 'text' && !t.content.trim())),
    );
    const isImage =
      (kids.length === 1 && (kids[0]!.type === 'image' || kids[0]!.type === 'wiki_embed')) ||
      (kids.length === 3 && kids[0]!.type === 'link_open' && kids[1]!.type === 'image' && kids[2]!.type === 'link_close');
    if (isImage) tokens[i]!.attrJoin('class', 'image-paragraph');
  }
}

const TOC_RE = /^(?:\[toc\]|\[\[_?toc_?\]\]|\$\{toc\})$/i;
const PAGEBREAK_RE = /^(?:\\pagebreak|\\newpage|<!--\s*(?:pagebreak|page-break|newpage)\s*-->)$/i;

function lineText(state: StateBlock, line: number): string | null {
  if (state.sCount[line]! - state.blkIndent >= 4) return null;
  return state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]!).trim();
}

function tocMarker(state: StateBlock, startLine: number, _end: number, silent: boolean): boolean {
  const text = lineText(state, startLine);
  if (text === null || !TOC_RE.test(text)) return false;
  if (silent) return true;
  const token = state.push('toc_marker', '', 0);
  token.map = [startLine, startLine + 1];
  token.block = true;
  state.line = startLine + 1;
  return true;
}

function pageBreak(state: StateBlock, startLine: number, _end: number, silent: boolean): boolean {
  const text = lineText(state, startLine);
  if (text === null || !PAGEBREAK_RE.test(text)) return false;
  if (silent) return true;
  const token = state.push('page_break', 'div', 0);
  token.map = [startLine, startLine + 1];
  token.block = true;
  state.line = startLine + 1;
  return true;
}

export const TOC_PLACEHOLDER = '<!--mdpdf:toc-->';

export function blocksPlugin(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'task_lists', taskLists);
  md.core.ruler.after('task_lists', 'image_paragraphs', imageParagraphs);
  md.block.ruler.before('fence', 'toc_marker', tocMarker, { alt: ['paragraph'] });
  md.block.ruler.before('html_block', 'page_break', pageBreak, { alt: ['paragraph'] });
  md.renderer.rules['task_checkbox'] = (tokens: Token[], idx: number) => {
    const status = (tokens[idx]!.meta as { status: string }).status;
    const checked = status !== ' ';
    return `<input type="checkbox" class="task-list-item-checkbox" disabled${checked ? ' checked' : ''}> `;
  };
  md.renderer.rules['toc_marker'] = () => TOC_PLACEHOLDER + '\n';
  md.renderer.rules['page_break'] = () => '<div class="page-break"></div>\n';
}
