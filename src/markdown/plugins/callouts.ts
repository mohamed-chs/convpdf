/**
 * Obsidian callouts and GitHub alerts, which share the same syntax:
 *
 *   > [!NOTE]
 *   > GitHub alert
 *
 *   > [!tip]- Custom *title*
 *   > Obsidian callout (foldable markers are accepted and ignored in print)
 */
import type { MarkdownIt, StateCore, Token } from 'markdown-it';
import { ICONS } from '../icons.ts';

interface CalloutStyle {
  icon: string;
  /** Canonical type used for colouring. */
  color: string;
}

// GitHub's five alert types keep GitHub's colours and icons; the remaining
// Obsidian types (and aliases) follow Obsidian's defaults.
const TYPES: Record<string, CalloutStyle> = {
  note: { icon: 'info', color: 'note' },
  tip: { icon: 'lightbulb', color: 'tip' },
  hint: { icon: 'lightbulb', color: 'tip' },
  important: { icon: 'message-square-warning', color: 'important' },
  warning: { icon: 'triangle-alert', color: 'warning' },
  attention: { icon: 'triangle-alert', color: 'warning' },
  caution: { icon: 'octagon-alert', color: 'caution' },
  abstract: { icon: 'clipboard-list', color: 'abstract' },
  summary: { icon: 'clipboard-list', color: 'abstract' },
  tldr: { icon: 'clipboard-list', color: 'abstract' },
  info: { icon: 'info', color: 'info' },
  todo: { icon: 'circle-check', color: 'todo' },
  success: { icon: 'check', color: 'success' },
  check: { icon: 'check', color: 'success' },
  done: { icon: 'check', color: 'success' },
  question: { icon: 'circle-help', color: 'question' },
  help: { icon: 'circle-help', color: 'question' },
  faq: { icon: 'circle-help', color: 'question' },
  failure: { icon: 'x', color: 'failure' },
  fail: { icon: 'x', color: 'failure' },
  missing: { icon: 'x', color: 'failure' },
  danger: { icon: 'zap', color: 'danger' },
  error: { icon: 'zap', color: 'danger' },
  bug: { icon: 'bug', color: 'bug' },
  example: { icon: 'list', color: 'example' },
  quote: { icon: 'quote', color: 'quote' },
  cite: { icon: 'quote', color: 'quote' },
};

const HEADER_RE = /^\[!([^\]|\s]+)(?:\|([^\]]*))?\]([+-]?)(?:[ \t]+([^\n]*))?[ \t]*(?:\n|$)/;

function titleCase(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
}

function callouts(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.type !== 'blockquote_open') continue;
    const para = tokens[i + 1];
    const inline = tokens[i + 2];
    if (para?.type !== 'paragraph_open' || inline?.type !== 'inline') continue;
    const m = HEADER_RE.exec(inline.content);
    if (!m) continue;

    const rawType = m[1]!;
    const type = rawType.toLowerCase();
    const style = TYPES[type] ?? { icon: 'pencil', color: 'note' };
    const metadata = m[2]?.trim() ?? '';
    const fold = m[3] ?? '';
    const title = m[4]?.trim() || titleCase(rawType.replace(/[-_]/g, ' '));
    const rest = inline.content.slice(m[0].length);

    const open = tokens[i]!;
    const level = open.level;
    let closeIdx = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j]!.type === 'blockquote_close' && tokens[j]!.level === level) {
        closeIdx = j;
        break;
      }
    }
    if (closeIdx === -1) continue;

    open.type = 'callout_open';
    open.tag = 'div';
    open.meta = { type, color: style.color, icon: style.icon, metadata, fold };
    const close = tokens[closeIdx]!;
    close.type = 'callout_close';
    close.tag = 'div';

    const titleOpen = new state.Token('callout_title_open', 'div', 1);
    titleOpen.meta = open.meta;
    const titleInline = new state.Token('inline', '', 0);
    titleInline.content = title;
    titleInline.children = [];
    titleInline.map = inline.map;
    const titleClose = new state.Token('callout_title_close', 'div', -1);
    const contentOpen = new state.Token('callout_content_open', 'div', 1);
    const contentClose = new state.Token('callout_content_close', 'div', -1);

    const hasRest = rest.trim() !== '';
    let replaced: Token[];
    if (hasRest) {
      inline.content = rest;
      replaced = [titleOpen, titleInline, titleClose, contentOpen, para, inline];
      tokens.splice(i + 1, 2, ...replaced);
    } else {
      // Drop the now-empty first paragraph (open, inline, close).
      replaced = [titleOpen, titleInline, titleClose, contentOpen];
      tokens.splice(i + 1, 3, ...replaced);
    }
    // Recompute the close position after splicing and insert content_close.
    const shift = replaced.length - (hasRest ? 2 : 3);
    const newClose = closeIdx + shift;
    const isEmpty = tokens[newClose - 1] === contentOpen;
    if (isEmpty) {
      tokens.splice(newClose - 1, 1); // no body: drop content wrapper
    } else {
      tokens.splice(newClose, 0, contentClose);
    }
  }
}

export function calloutsPlugin(md: MarkdownIt): void {
  md.core.ruler.before('inline', 'callouts', callouts);
  const esc = md.utils.escapeHtml;
  md.renderer.rules['callout_open'] = (tokens, idx) => {
    const tok = tokens[idx]!;
    const meta = tok.meta as { type: string; color: string; metadata: string; fold: string };
    const id = tok.attrGet('id');
    return (
      `<div class="callout" data-callout="${esc(meta.type)}" data-color="${esc(meta.color)}"` +
      (meta.metadata ? ` data-callout-metadata="${esc(meta.metadata)}"` : '') +
      (meta.fold ? ` data-callout-fold="${esc(meta.fold)}"` : '') +
      (id ? ` id="${esc(String(id))}"` : '') +
      '>\n'
    );
  };
  md.renderer.rules['callout_close'] = () => '</div>\n';
  md.renderer.rules['callout_title_open'] = (tokens, idx) => {
    const meta = tokens[idx]!.meta as { icon: string };
    return `<div class="callout-title"><span class="callout-icon">${ICONS[meta.icon] ?? ''}</span><span class="callout-title-inner">`;
  };
  md.renderer.rules['callout_title_close'] = () => '</span></div>\n';
  md.renderer.rules['callout_content_open'] = () => '<div class="callout-content">\n';
  md.renderer.rules['callout_content_close'] = () => '</div>\n';
}
