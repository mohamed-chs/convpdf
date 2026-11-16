/**
 * File resolution for wikilinks, embeds and relative assets.
 *
 * A "vault" is the folder notes are resolved against. Inside an Obsidian
 * vault (a folder containing `.obsidian/`) that is the vault root and we honour
 * a few of its settings; elsewhere it is the folder of the converted file.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface VaultConfig {
  /** Obsidian "Strict line breaks" setting (default false: newlines are <br>). */
  strictLineBreaks?: boolean;
}

const MAX_INDEX_ENTRIES = 50_000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash', '.hg', '.svn']);

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findObsidianRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, '.obsidian'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const vaultCache = new Map<string, Vault>();

export class Vault {
  readonly root: string;
  readonly isObsidian: boolean;
  readonly config: VaultConfig;
  #index: Map<string, string[]> | null = null;

  constructor(root: string, isObsidian: boolean) {
    this.root = root;
    this.isObsidian = isObsidian;
    this.config = isObsidian ? readObsidianConfig(root) : {};
  }

  /** The vault for a file (or directory). Cached per root. */
  static for(path: string, isDir = false): Vault {
    const dir = isDir ? resolve(path) : dirname(resolve(path));
    const obsidian = findObsidianRoot(dir);
    const root = obsidian ?? dir;
    let vault = vaultCache.get(root);
    if (!vault) {
      vault = new Vault(root, obsidian !== null);
      vaultCache.set(root, vault);
    }
    return vault;
  }

  /** Forget cached indexes (watch mode, after files are added or removed). */
  static invalidate(): void {
    for (const vault of vaultCache.values()) vault.#index = null;
  }

  #buildIndex(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    let count = 0;
    const add = (key: string, path: string) => {
      const list = index.get(key);
      if (list) list.push(path);
      else index.set(key, [path]);
    };
    const walk = (dir: string, depth: number) => {
      if (depth > 24 || count > MAX_INDEX_ENTRIES) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (count++ > MAX_INDEX_ENTRIES) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
          walk(full, depth + 1);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          const lower = entry.name.toLowerCase();
          add(lower, full);
          if (lower.endsWith('.md')) add(lower.slice(0, -3), full);
        }
      }
    };
    walk(this.root, 0);
    return index;
  }

  get index(): Map<string, string[]> {
    this.#index ??= this.#buildIndex();
    return this.#index;
  }

  /**
   * Resolve a wikilink target (`Note`, `folder/Note`, `image.png`) the way
   * Obsidian does: exact relative paths first, then by file name anywhere in
   * the vault, preferring the closest match.
   */
  resolveLink(target: string, fromDir: string): string | null {
    const clean = target.trim().replace(/\\/g, '/');
    if (!clean) return null;
    const variants = extname(clean).toLowerCase() === '.md' ? [clean] : [clean + '.md', clean];
    for (const v of variants) {
      for (const base of [fromDir, this.root]) {
        const candidate = resolve(base, v.replace(/^\/+/, ''));
        if (isFile(candidate)) return candidate;
      }
    }
    const name = basename(clean).toLowerCase();
    const matches = this.index.get(name) ?? this.index.get(name + '.md');
    if (!matches?.length) return null;
    let pool = matches;
    if (clean.includes('/')) {
      const suffix = clean.toLowerCase().replace(/^\/+/, '');
      const bySuffix = matches.filter((m) => {
        const rel = relative(this.root, m).split(sep).join('/').toLowerCase();
        return rel === suffix || rel === suffix + '.md' || rel.endsWith('/' + suffix) || rel.endsWith('/' + suffix + '.md');
      });
      if (bySuffix.length) pool = bySuffix;
    }
    return closest(pool, fromDir);
  }

  /**
   * Resolve a relative path from a markdown link or image. Falls back to
   * vault-root-relative paths and file name lookup inside Obsidian vaults.
   */
  resolvePath(path: string, fromDir: string): string | null {
    if (isAbsolute(path) && isFile(path)) return path;
    const direct = resolve(fromDir, path);
    if (isFile(direct)) return direct;
    if (this.isObsidian) {
      const fromRoot = resolve(this.root, path.replace(/^\/+/, ''));
      if (isFile(fromRoot)) return fromRoot;
      const matches = this.index.get(basename(path).toLowerCase());
      if (matches?.length) return closest(matches, fromDir);
    }
    return null;
  }
}

function closest(paths: string[], fromDir: string): string {
  let best = paths[0]!;
  let bestScore = Infinity;
  for (const p of paths) {
    const rel = relative(fromDir, dirname(p));
    // Same folder wins, then fewest path segments away.
    const score = rel === '' ? 0 : rel.split(sep).length + (rel.startsWith('..') ? 0.5 : 0);
    if (score < bestScore || (score === bestScore && p.length < best.length)) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

function readObsidianConfig(root: string): VaultConfig {
  try {
    const app = JSON.parse(readFileSync(join(root, '.obsidian', 'app.json'), 'utf8')) as Record<string, unknown>;
    return { strictLineBreaks: typeof app['strictLineBreaks'] === 'boolean' ? app['strictLineBreaks'] : undefined };
  } catch {
    return {};
  }
}
