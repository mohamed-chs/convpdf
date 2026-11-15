/**
 * Config file discovery/loading and markdown file listing, shared by the CLI
 * and the web UI server.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isMarkdownPath } from './markdown/render-rules.ts';
import { coerceOptions, type ConvertOptions } from './options.ts';

/** A problem with how the tool was invoked (exit code 2). */
export class UsageError extends Error {}

export const CONFIG_NAMES = ['mdpdf.yaml', 'mdpdf.yml', 'mdpdf.json', '.mdpdf.yaml', '.mdpdf.yml', '.mdpdf.json'];

/** Nearest config file in `startDir` or its parents. */
export function findConfig(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadConfig(path: string, warn: (m: string) => void): Promise<Partial<ConvertOptions>> {
  const text = readFileSync(path, 'utf8');
  let data: unknown;
  try {
    data = path.endsWith('.json') ? JSON.parse(text) : (await import('yaml')).parse(text);
  } catch (err) {
    throw new UsageError(`Invalid config file ${path}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
  }
  if (!data || typeof data !== 'object') return {};
  const opts = coerceOptions(data as Record<string, unknown>, warn, basename(path));
  // Paths in a config file are relative to the config file.
  const dir = dirname(path);
  if (opts.css) opts.css = opts.css.map((p) => resolve(dir, p));
  if (opts.theme && /\.css$/i.test(opts.theme)) opts.theme = resolve(dir, opts.theme);
  return opts;
}

/** All markdown files under `dir` (skipping dot folders and node_modules), naturally sorted. */
export function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && isMarkdownPath(e.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}
