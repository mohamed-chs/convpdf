/**
 * YAML front matter (`---` fenced block at the very top of a file).
 */

export interface FrontmatterSplit {
  /** Raw YAML text, or null when the file has no front matter. */
  raw: string | null;
  body: string;
  /** 0-based line number of the source where `body` starts. */
  bodyLine: number;
}

const FM_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(source: string): FrontmatterSplit {
  const src = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const m = FM_RE.exec(src);
  if (!m) return { raw: null, body: src, bodyLine: 0 };
  const raw = m[1] ?? '';
  // A thematic break followed by a setext heading looks similar; only treat
  // the block as front matter if it is empty or looks like a YAML mapping.
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'));
  if (firstLine !== undefined && !/^\s*("[^"]*"|'[^']*'|[^\s:#][^:]*?)\s*:(\s|$)/.test(firstLine)) {
    return { raw: null, body: src, bodyLine: 0 };
  }
  return { raw, body: src.slice(m[0].length), bodyLine: m[0].split('\n').length - 1 };
}

export async function parseFrontmatter(raw: string | null, onError?: (message: string) => void): Promise<Record<string, unknown>> {
  if (!raw || !raw.trim()) return {};
  try {
    const { parse } = await import('yaml');
    const data: unknown = parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch (err) {
    onError?.(`Invalid YAML front matter: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    return {};
  }
}
