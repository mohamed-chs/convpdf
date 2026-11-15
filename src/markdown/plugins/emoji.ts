/**
 * GitHub emoji shortcodes (:tada:). A direct lookup at each ':' is much
 * cheaper than markdown-it-emoji's one-big-regex scan of every text token.
 */
import type { MarkdownIt, StateInline } from 'markdown-it';
import EMOJI from 'markdown-it-emoji/lib/data/full.mjs';

const NAME_RE = /:([a-z0-9_+-]{1,60}):/y;

function emojiRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x3a /* : */) return false;
  NAME_RE.lastIndex = state.pos;
  const m = NAME_RE.exec(state.src);
  if (!m) return false;
  const emoji = EMOJI[m[1]!];
  if (!emoji) return false;
  if (!silent) {
    const token = state.push('emoji', '', 0);
    token.content = emoji;
    token.markup = m[1]!;
  }
  state.pos += m[0].length;
  return true;
}

export function emojiPlugin(md: MarkdownIt): void {
  md.inline.ruler.push('emoji', emojiRule);
  md.renderer.rules['emoji'] = (tokens, idx) => tokens[idx]!.content;
}
