/**
 * Disk cache of rendered Mermaid diagrams.
 *
 * Rendering Mermaid costs a 5.5 MB script plus ~150 ms of warm-up per page.
 * Diagrams rarely change between runs (watch mode, the web UI's PDF button,
 * re-running after a text edit), so rendered SVGs are stored by a hash of
 * everything that affects them. When every diagram in a document is cached,
 * the page doesn't load Mermaid at all.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { rename, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Prune when the cache holds more than this many diagrams. */
const MAX_ENTRIES = 2000;
const KEEP_ENTRIES = 1500;

/** The platform's per-user cache directory for mdpdf. */
export function defaultCacheDir(): string {
  const env = process.env['MDPDF_CACHE_DIR'];
  if (env) return env;
  if (process.platform === 'win32') return join(process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local'), 'mdpdf', 'Cache');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'mdpdf');
  return join(process.env['XDG_CACHE_HOME'] || join(homedir(), '.cache'), 'mdpdf');
}

function unescapeHtml(s: string): string {
  return s.replace(/&(lt|gt|quot|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', amp: '&' })[e]!);
}

export interface InlineResult {
  body: string;
  /** Diagrams that still need rendering in the page. */
  missing: number;
  /** Key prefix for storing the diagrams rendered in the page. */
  scope: string;
}

export class MermaidCache {
  readonly dir: string;
  #memory = new Map<string, string>();
  #ready = false;
  #pruned = false;

  constructor(dir: string) {
    this.dir = join(dir, 'mermaid');
  }

  #key(scope: string, source: string): string {
    return createHash('sha256').update(scope).update('\0').update(source).digest('hex').slice(0, 32);
  }

  #path(key: string): string {
    return join(this.dir, `${key}.svg`);
  }

  #read(key: string): string | null {
    const hit = this.#memory.get(key);
    if (hit !== undefined) return hit;
    try {
      const svg = readFileSync(this.#path(key), 'utf8');
      this.#memory.set(key, svg);
      // Mark as recently used so pruning keeps it.
      const now = new Date();
      utimes(this.#path(key), now, now).catch(() => {});
      return svg;
    } catch {
      return null;
    }
  }

  /**
   * Replace `<pre class="mermaid">` blocks whose rendering is cached with the
   * SVG, exactly as Mermaid itself would leave the element.
   *
   * `scope` must capture everything besides the source that affects the
   * result: versions, Mermaid config, stylesheets.
   */
  inline(body: string, scope: string): InlineResult {
    let missing = 0;
    let n = 0;
    const out = body.replace(/<pre class="mermaid">([^<]*)<\/pre>/g, (whole, escaped: string) => {
      const source = unescapeHtml(escaped);
      const svg = this.#read(this.#key(scope, source));
      if (svg === null) {
        missing++;
        return whole;
      }
      return `<pre class="mermaid" data-processed="true" data-source="${escaped.replace(/"/g, '&quot;')}">${uniqueIds(svg, `mermaid-c${++n}`)}</pre>`;
    });
    return { body: out, missing, scope };
  }

  /** Store diagrams rendered in the page ([source, svg] pairs). */
  async store(scope: string, rendered: Array<[string, string]>): Promise<void> {
    if (!rendered.length) return;
    if (!this.#ready) {
      mkdirSync(this.dir, { recursive: true });
      this.#ready = true;
    }
    await Promise.all(
      rendered.map(async ([source, svg]) => {
        const key = this.#key(scope, source);
        if (this.#memory.has(key)) return;
        this.#memory.set(key, svg);
        const tmp = `${this.#path(key)}.${process.pid}.tmp`;
        await writeFile(tmp, svg);
        await rename(tmp, this.#path(key));
      }),
    );
    if (!this.#pruned) {
      this.#pruned = true;
      this.prune();
    }
  }

  /** Drop the least recently used diagrams once the cache grows large. */
  prune(max = MAX_ENTRIES, keep = KEEP_ENTRIES): void {
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith('.svg'));
      if (files.length <= max) return;
      const dated = files.map((f) => ({ f, t: statSync(join(this.dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const { f } of dated.slice(keep)) rmSync(join(this.dir, f), { force: true });
    } catch {
      // The cache is best-effort.
    }
  }
}

/**
 * Give a cached SVG a fresh id. Mermaid scopes its styles and markers by the
 * root element's id (`#mermaid-123 .node`, `url(#mermaid-123_arrow)`), so ids
 * must be unique within a document.
 */
function uniqueIds(svg: string, id: string): string {
  const old = /^<svg[^>]*?\sid="([^"]+)"/.exec(svg)?.[1];
  return old ? svg.split(old).join(id) : svg;
}
