import type { Heading } from './types.ts';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/**
 * Render a nested table of contents. Every entry carries an empty
 * `.toc-page` slot that the PDF step fills with the real page number.
 */
export function renderToc(headings: Heading[], depth: number, title: string | false): string {
  const items = headings.filter((h) => h.level <= depth);
  if (!items.length) return '';
  const min = Math.min(...items.map((h) => h.level));
  let out = '<nav class="toc">\n';
  if (title) out += `<h2 class="toc-title">${escapeHtml(title)}</h2>\n`;
  out += '<ol class="toc-list">';
  let cur = 1;
  let open = false;
  for (const h of items) {
    const d = h.level - min + 1;
    if (d > cur) {
      while (cur < d) {
        if (!open) out += '<li class="toc-gap">';
        out += '<ol>';
        cur++;
        open = false;
      }
    } else {
      if (open) out += '</li>';
      while (cur > d) {
        out += '</ol></li>';
        cur--;
      }
    }
    const id = escapeHtml(h.id);
    out +=
      `<li class="toc-level-${h.level}"><a href="#${id}"><span class="toc-text">${escapeHtml(h.text)}</span>` +
      `<span class="toc-leader"></span><span class="toc-page" data-target="${id}"></span></a>`;
    open = true;
  }
  if (open) out += '</li>';
  while (cur > 1) {
    out += '</ol></li>';
    cur--;
  }
  out += '</ol>\n</nav>\n';
  return out;
}
