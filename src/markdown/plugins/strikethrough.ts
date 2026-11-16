/**
 * GFM strikethrough: `~~text~~` and `~text~`.
 *
 * markdown-it only supports the double-tilde form. Per the GFM spec, one or
 * two tildes delimit strikethrough, the closing run must have the same length
 * as the opening one, and runs of three or more are literal text.
 */
import type { MarkdownIt as Md, StateInline } from 'markdown-it';

const TILDE = 0x7e;
/** Distinct marker for single tildes so they never pair with double ones. */
const SINGLE = 0xe07e;

type Delimiter = StateInline['delimiters'][number];

function tokenize(state: StateInline, silent: boolean): boolean {
  if (silent || state.src.charCodeAt(state.pos) !== TILDE) return false;
  const scanned = state.scanDelims(state.pos, true);
  const len = scanned.length;
  const token = state.push('text', '', 0);
  token.content = '~'.repeat(len);
  if (len <= 2) {
    state.delimiters.push({
      marker: len === 2 ? TILDE : SINGLE,
      length: 0,
      token: state.tokens.length - 1,
      end: -1,
      open: scanned.can_open,
      close: scanned.can_close,
    });
  }
  state.pos += len;
  return true;
}

function convert(state: StateInline, delimiters: Delimiter[]): void {
  for (const start of delimiters) {
    if ((start.marker !== TILDE && start.marker !== SINGLE) || start.end === -1) continue;
    const end = delimiters[start.end]!;
    const markup = start.marker === TILDE ? '~~' : '~';
    const open = state.tokens[start.token]!;
    open.type = 's_open';
    open.tag = 's';
    open.nesting = 1;
    open.markup = markup;
    open.content = '';
    const close = state.tokens[end.token]!;
    close.type = 's_close';
    close.tag = 's';
    close.nesting = -1;
    close.markup = markup;
    close.content = '';
  }
}

function postProcess(state: StateInline): boolean {
  convert(state, state.delimiters);
  for (const meta of state.tokens_meta) if (meta?.delimiters) convert(state, meta.delimiters);
  return false;
}

export function strikethroughPlugin(md: Md): void {
  md.inline.ruler.at('strikethrough', tokenize);
  md.inline.ruler2.at('strikethrough', postProcess);
}
