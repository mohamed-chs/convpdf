/**
 * Lazy KaTeX loader. KaTeX is only imported when a document contains math.
 */
type Katex = typeof import('katex').default;

let katex: Katex | null = null;
let mhchem = false;

export async function loadKatex(withMhchem: boolean): Promise<void> {
  katex ??= (await import('katex')).default;
  if (withMhchem && !mhchem) {
    await import('katex/contrib/mhchem');
    mhchem = true;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function renderMath(tex: string, display: boolean, macros: Record<string, string>): string {
  if (!katex) return `<code class="math-source">${escapeHtml(tex)}</code>`;
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: true,
      output: 'html',
      macros,
      globalGroup: true,
      strict: 'ignore',
      trust: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `<span class="math-error" title="${escapeHtml(message)}">${escapeHtml(tex)}</span>`;
  }
}
