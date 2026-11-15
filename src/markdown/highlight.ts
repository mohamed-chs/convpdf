/**
 * Syntax highlighting with Shiki (TextMate grammars, VS Code quality).
 *
 * Shiki is loaded lazily and only the grammars a document uses are loaded.
 * After `prepareHighlighter()` resolves, `highlight()` is synchronous, which
 * is what markdown-it's renderer needs.
 */
import type { HighlighterCore } from 'shiki/core';

let highlighter: HighlighterCore | null = null;
let creating: Promise<HighlighterCore> | null = null;
type Loader = () => Promise<any>;
let bundled: Record<string, Loader> = {};
let themes: Record<string, Loader> = {};
const failed = new Set<string>();

/** Languages that should be rendered as plain text without loading a grammar. */
const PLAIN = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'none', 'nohighlight', 'output', 'console-output']);

export const DEFAULT_CODE_THEME = 'github-light';

async function getHighlighter(): Promise<HighlighterCore> {
  if (highlighter) return highlighter;
  creating ??= (async () => {
    const [{ createHighlighterCore }, { createOnigurumaEngine }, langs, themeMod] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/oniguruma'),
      import('shiki/langs'),
      import('shiki/themes'),
    ]);
    bundled = langs.bundledLanguages;
    themes = themeMod.bundledThemes;
    highlighter = await createHighlighterCore({
      themes: [],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    });
    return highlighter;
  })();
  return creating;
}

export function normalizeLang(lang: string): string {
  const l = lang.toLowerCase().trim();
  const aliases: Record<string, string> = {
    'c++': 'cpp',
    'c#': 'csharp',
    'f#': 'fsharp',
    sh: 'bash',
    zsh: 'bash',
    shell: 'bash',
    console: 'shellsession',
    'shell-session': 'shellsession',
    golang: 'go',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    yml: 'yaml',
    dockerfile: 'docker',
    'objective-c': 'objc',
    patch: 'diff',
    ps1: 'powershell',
    pwsh: 'powershell',
    tex: 'latex',
  };
  return aliases[l] ?? l;
}

/** Load the theme and every grammar in `langs` that Shiki knows. */
export async function prepareHighlighter(langs: Iterable<string>, theme: string): Promise<void> {
  const wanted = [...new Set([...langs].map(normalizeLang))].filter((l) => !PLAIN.has(l) && !failed.has(l));
  // Nothing to highlight: don't pay for loading Shiki (~50 ms).
  if (wanted.length === 0) return;
  const hl = await getHighlighter();
  const tasks: Promise<unknown>[] = [];
  if (!hl.getLoadedThemes().includes(theme)) {
    const loader = themes[theme];
    if (!loader) throw new Error(`Unknown code theme "${theme}". See https://shiki.style/themes for the list.`);
    tasks.push(hl.loadTheme(loader()));
  }
  const loaded = new Set(hl.getLoadedLanguages());
  for (const lang of wanted) {
    if (loaded.has(lang)) continue;
    const loader = bundled[lang];
    if (!loader) {
      failed.add(lang);
      continue;
    }
    tasks.push(
      hl.loadLanguage(loader()).catch(() => {
        failed.add(lang);
      }),
    );
  }
  await Promise.all(tasks);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/**
 * Highlight `code` into a sequence of block `<span class="line">` elements, or
 * null when the language is unknown (the caller renders plain text).
 */
export function highlight(code: string, lang: string, theme: string): string | null {
  const l = normalizeLang(lang);
  if (!highlighter || PLAIN.has(l) || !highlighter.getLoadedLanguages().includes(l)) return null;
  if (!highlighter.getLoadedThemes().includes(theme)) return null;
  const lines = highlighter.codeToTokensBase(code, { lang: l, theme });
  let out = '';
  for (const line of lines) {
    out += '<span class="line">';
    for (const token of line) {
      const style: string[] = [];
      if (token.color) style.push(`color:${token.color}`);
      const fs = token.fontStyle ?? 0;
      if (fs > 0) {
        if (fs & 1) style.push('font-style:italic');
        if (fs & 2) style.push('font-weight:600');
        if (fs & 4) style.push('text-decoration:underline');
        if (fs & 8) style.push('text-decoration:line-through');
      }
      const text = escapeHtml(token.content);
      out += style.length ? `<span style="${style.join(';')}">${text}</span>` : text;
    }
    out += '</span>';
  }
  return out;
}

/** Plain (unhighlighted) code, split into lines like `highlight()`. */
export function plainLines(code: string): string {
  return code
    .split('\n')
    .map((l) => `<span class="line">${escapeHtml(l)}</span>`)
    .join('');
}
