/**
 * The live HTML preview: an iframe updated in place when only the document
 * body changed (keeps scroll position, images and rendered diagrams), and
 * reloaded when styles or scripts changed.
 */

const ARTICLE_OPEN = '<article class="markdown-body">';
const ARTICLE_CLOSE = '</article>';

interface MermaidApi {
  parse(text: string): Promise<unknown>;
  run(opts: { nodes: Element[] }): Promise<void>;
}

type PreviewWindow = Window & { mermaid?: MermaidApi; __convpdfReady?: Promise<string[]> };

function split(html: string): { shell: string; body: string } | null {
  const start = html.indexOf(ARTICLE_OPEN);
  const end = html.lastIndexOf(ARTICLE_CLOSE);
  if (start === -1 || end === -1) return null;
  // The <title> follows the first heading; it doesn't need a reload.
  const shell = (html.slice(0, start) + html.slice(end)).replace(/<title>[^<]*<\/title>/, '');
  return { shell, body: html.slice(start + ARTICLE_OPEN.length, end) };
}

export class Preview {
  readonly frame: HTMLIFrameElement;
  #shell = '';
  #ready: Promise<void> = Promise.resolve();
  #anchors: Array<{ line: number; top: number }> | null = null;
  #diagrams = new Map<string, string>();
  #onScroll: () => void;
  #onLink: (href: string) => void;
  #onDiagramWarning: (message: string) => void;

  constructor(frame: HTMLIFrameElement, handlers: { onScroll(): void; onLink(href: string): void; onDiagramWarning(message: string): void }) {
    this.frame = frame;
    this.#onScroll = handlers.onScroll;
    this.#onLink = handlers.onLink;
    this.#onDiagramWarning = handlers.onDiagramWarning;
  }

  get #win(): PreviewWindow | null {
    return this.frame.contentWindow as PreviewWindow | null;
  }

  get #doc(): Document | null {
    return this.frame.contentDocument;
  }

  /** Show a newly rendered document. */
  async update(html: string): Promise<void> {
    await this.#ready;
    const parts = split(html);
    const article = this.#doc?.querySelector('article.markdown-body');
    if (!parts || parts.shell !== this.#shell || !article) {
      await this.#reload(html, parts?.shell ?? '');
      return;
    }
    this.#harvestDiagrams();
    article.innerHTML = parts.body;
    this.#anchors = null;
    await this.#renderDiagrams(article);
    this.#anchors = null;
  }

  #reload(html: string, shell: string): Promise<void> {
    const scroll = this.#win?.scrollY ?? 0;
    this.#harvestDiagrams();
    this.#shell = shell;
    this.#ready = new Promise<void>((resolve) => {
      const onLoad = () => {
        this.frame.removeEventListener('load', onLoad);
        const win = this.#win;
        const doc = this.#doc;
        if (!win || !doc) return resolve();
        this.#fit();
        win.scrollTo(0, scroll);
        win.addEventListener('scroll', () => this.#onScroll(), { passive: true });
        win.addEventListener('resize', () => {
          this.#fit();
          this.#anchors = null;
        });
        doc.addEventListener('click', (e) => this.#click(e));
        doc.addEventListener('load', () => (this.#anchors = null), true); // images
        // Rendering diagrams changes heights; restore the position once settled.
        (win.__convpdfReady ?? Promise.resolve([]))
          .then(() => {
            this.#anchors = null;
            if (scroll) win.scrollTo(0, scroll);
          })
          .catch(() => {});
        resolve();
      };
      this.frame.addEventListener('load', onLoad);
    });
    this.frame.srcdoc = html;
    this.#anchors = null;
    return this.#ready;
  }

  /** Scale the page down to the pane width, like a PDF viewer's "fit width". */
  #fit(): void {
    const win = this.#win;
    const article = this.#doc?.querySelector<HTMLElement>('article.markdown-body');
    if (!win || !article) return;
    article.style.zoom = '';
    article.ownerDocument.body.classList.remove('reflow');
    const available = win.innerWidth - 40;
    const scale = available / article.offsetWidth;
    if (scale >= 1) return;
    if (scale >= 0.8) article.style.zoom = String(scale);
    else article.ownerDocument.body.classList.add('reflow'); // too narrow to be legible: reflow instead
  }

  #harvestDiagrams(): void {
    const doc = this.#doc;
    if (!doc) return;
    const keep = new Map<string, string>();
    for (const pre of doc.querySelectorAll('pre.mermaid[data-processed="true"]')) {
      const source = pre.getAttribute('data-source');
      if (source) keep.set(source, pre.innerHTML);
    }
    // Only keep diagrams that still exist, so the cache cannot grow forever.
    if (keep.size) this.#diagrams = keep;
  }

  async #renderDiagrams(root: Element): Promise<void> {
    const nodes = [...root.querySelectorAll('pre.mermaid')];
    if (!nodes.length) return;
    const pending: Element[] = [];
    for (const pre of nodes) {
      const source = pre.textContent ?? '';
      const svg = this.#diagrams.get(source);
      pre.setAttribute('data-source', source);
      if (svg) {
        pre.innerHTML = svg;
        pre.setAttribute('data-processed', 'true');
      } else {
        pending.push(pre);
      }
    }
    const mermaid = this.#win?.mermaid;
    if (!mermaid) return;
    for (const pre of pending) {
      try {
        await mermaid.parse(pre.textContent ?? '');
        await mermaid.run({ nodes: [pre] });
      } catch (err) {
        pre.closest('.mermaid-diagram')?.classList.add('mermaid-error');
        pre.setAttribute('data-processed', 'error');
        this.#onDiagramWarning(String((err as Error)?.message ?? err).split('\n')[0] ?? '');
      }
    }
  }

  #click(e: MouseEvent): void {
    const target = e.target as Element | null;
    const a = target?.closest('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      this.#doc?.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    this.#onLink(href);
  }

  #positions(): Array<{ line: number; top: number }> {
    if (this.#anchors) return this.#anchors;
    const doc = this.#doc;
    const win = this.#win;
    const out: Array<{ line: number; top: number }> = [];
    if (doc && win) {
      for (const el of doc.querySelectorAll<HTMLElement>('article.markdown-body > [data-line], article.markdown-body > section > [data-line]')) {
        const top = el.getBoundingClientRect().top + win.scrollY;
        const line = Number(el.dataset['line']);
        // Keep the list monotonic in both line and position.
        const last = out[out.length - 1];
        if (!last || (line > last.line && top >= last.top)) out.push({ line, top });
      }
    }
    this.#anchors = out;
    return out;
  }

  /** Fractional source line at the top of the preview. */
  topLine(): number {
    const win = this.#win;
    if (!win) return 0;
    const y = win.scrollY + 8;
    const pos = this.#positions();
    if (!pos.length || y <= pos[0]!.top) return 0;
    for (let i = 0; i < pos.length; i++) {
      const a = pos[i]!;
      const b = pos[i + 1];
      if (!b || y < b.top) {
        if (!b) return a.line;
        return a.line + ((y - a.top) / Math.max(1, b.top - a.top)) * (b.line - a.line);
      }
    }
    return 0;
  }

  scrollToLine(line: number): void {
    const win = this.#win;
    if (!win) return;
    const pos = this.#positions();
    if (!pos.length) return;
    if (line <= pos[0]!.line) {
      win.scrollTo(0, (pos[0]!.top * line) / Math.max(1, pos[0]!.line) - 8);
      return;
    }
    for (let i = 0; i < pos.length; i++) {
      const a = pos[i]!;
      const b = pos[i + 1];
      if (!b || line < b.line) {
        const top = b ? a.top + ((line - a.line) / Math.max(1, b.line - a.line)) * (b.top - a.top) : a.top;
        win.scrollTo(0, top - 8);
        return;
      }
    }
  }
}
