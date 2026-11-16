/**
 * CodeMirror 6 markdown editor.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, dropCursor, EditorView, highlightActiveLine, highlightSpecialChars, keymap, rectangularSelection } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.18em', color: 'var(--md-heading)' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.1em', color: 'var(--md-heading)' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '700', color: 'var(--md-heading)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--md-link)' },
  { tag: t.monospace, color: 'var(--md-code)' },
  { tag: t.quote, color: 'var(--md-quote)' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--md-mark)' },
  { tag: t.labelName, color: 'var(--md-link)' },
  { tag: t.string, color: 'var(--md-code)' },
  { tag: t.comment, color: 'var(--md-mark)', fontStyle: 'italic' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13.5px', backgroundColor: 'var(--editor-bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { padding: '24px 0 40vh', caretColor: 'var(--accent)', maxWidth: '78ch', margin: '0 auto' },
  '.cm-line': { padding: '0 28px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--editor-selection) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--editor-match)' },
  '.cm-searchMatch': { backgroundColor: 'var(--editor-match)', outline: '1px solid var(--border-strong)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--editor-selection)' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '8px 12px', fontFamily: 'var(--font-ui)', fontSize: '12px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'inherit', fontSize: '12px' },
  '.cm-textfield': { border: '1px solid var(--border-strong)', borderRadius: '5px', background: 'var(--bg)', color: 'var(--text)', padding: '3px 6px' },
  '.cm-button': { backgroundImage: 'none', background: 'var(--surface-2)', border: '1px solid var(--border-strong)', borderRadius: '5px', color: 'var(--text)', padding: '3px 8px' },
});

export interface Editor {
  view: EditorView;
  getText(): string;
  /** Replace the whole document (optionally keeping the history clean). */
  setText(text: string, resetHistory?: boolean): void;
  /** Fractional 0-based line at the top of the viewport. */
  topLine(): number;
  scrollToLine(line: number): void;
  focus(): void;
}

export function createEditor(parent: HTMLElement, opts: { onChange(): void; onScroll(): void }): Editor {
  const extensions = (): Extension[] => [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: false }),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(highlight),
    theme,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange();
    }),
    EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off' }),
  ];

  const view = new EditorView({ state: EditorState.create({ doc: '', extensions: extensions() }), parent });
  view.scrollDOM.addEventListener('scroll', () => opts.onScroll(), { passive: true });

  const docOffset = () => view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop;

  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(text, resetHistory = false) {
      if (resetHistory) {
        view.setState(EditorState.create({ doc: text, extensions: extensions() }));
        return;
      }
      // Keep the cursor roughly where it was (external edits, reloads).
      const head = Math.min(view.state.selection.main.head, text.length);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: head } });
    },
    topLine() {
      const y = view.scrollDOM.scrollTop - docOffset();
      if (y <= 0) return 0;
      const block = view.lineBlockAtHeight(y);
      const line = view.state.doc.lineAt(block.from).number - 1;
      return line + Math.min(1, Math.max(0, (y - block.top) / Math.max(1, block.height)));
    },
    scrollToLine(line) {
      const doc = view.state.doc;
      const index = Math.max(0, Math.min(doc.lines - 1, Math.floor(line)));
      const block = view.lineBlockAt(doc.line(index + 1).from);
      view.scrollDOM.scrollTop = block.top + (line - index) * block.height + docOffset();
    },
    focus: () => view.focus(),
  };
}
