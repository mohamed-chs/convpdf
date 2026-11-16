/**
 * convpdf command line interface (loaded by the cli.ts entry point).
 */
import { existsSync, globSync, statSync, watch, type FSWatcher } from 'node:fs';
import { cpus } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { Converter, type Job, type JobResult } from './convert.ts';
import type { Browser } from './pdf/browser.ts';
import { themeNames } from './document.ts';
import { isMarkdownPath } from './markdown/render-rules.ts';
import { openTarget } from './open.ts';
import { trace } from './debug.ts';
import { findConfig, listMarkdown, loadConfig, UsageError } from './config.ts';
import type { ConvertOptions } from './options.ts';
import { Vault } from './vault.ts';
import { VERSION } from './version.ts';

const HELP = `
convpdf ${VERSION} — convert Markdown to beautiful PDFs

Usage
  convpdf <file.md | folder | -> [more...] [options]
  convpdf serve [folder] [--port 4400] [--open]     start the web UI

Examples
  convpdf README.md                    write README.pdf next to it
  convpdf notes/ -o pdf/               convert a folder, mirroring its structure
  convpdf ch1.md ch2.md -o book.pdf    merge several files into one PDF
  convpdf doc.md --toc --theme serif   table of contents, serif theme
  convpdf doc.md -w --open             re-render on every save and open the PDF
  cat doc.md | convpdf - > doc.pdf     stdin to stdout

Output
  -o, --output <path>      Output file or folder (default: next to each input)
  -w, --watch              Re-render when the file, its images or embeds change
      --open               Open the PDF when done
      --html               Write HTML instead of PDF

Layout
  -t, --theme <name|file>  ${themeNames().join(', ')}, or a .css file (default: default)
      --css <file>         Extra stylesheet (repeatable)
  -p, --paper <size>       A4, Letter, Legal, A3, A5, ... or "210mm 297mm"
                           (default: Letter in the Americas, A4 elsewhere)
  -l, --landscape          Landscape orientation
  -m, --margin <css>       Page margins, e.g. "20mm" or "1in 0.75in"
      --font-size <size>   Base font size, e.g. 11pt
      --toc                Add a table of contents with page numbers
      --toc-depth <n>      Heading levels in the table of contents (default: 3)
      --toc-title <text>   Table of contents heading (default: Contents)
      --break-before <h>   Start each h1 (or h2) on a new page
      --header <template>  Page header, e.g. "{title}||{date}"
      --footer <template>  Page footer (default: "{page} / {pages}")
      --no-page-numbers    No footer
                           Templates: "left|center|right" with {page} {pages}
                           {title} {author} {date} {file}

Content
      --line-numbers       Number lines in code blocks
      --code-theme <name>  Shiki theme for code (default: github-light)
      --mermaid-theme <t>  Diagram theme: default, neutral, dark, forest
                           (default: matches the convpdf theme)
      --breaks             Treat single newlines as line breaks
                           (automatic inside Obsidian vaults)
      --frontmatter        Show YAML front matter as a properties table
      --no-title-block     Don't render a title block from front matter
      --title <text>       Document title (PDF metadata)
      --author <text>      Document author (PDF metadata)

Other
      --config <file>      Config file (default: nearest convpdf.yaml / convpdf.json)
      --chrome <path>      Chrome/Chromium/Edge executable (or CONVPDF_CHROME)
  -j, --jobs <n>           Documents rendered in parallel (default: 4)
      --timeout <seconds>  Max time to wait for a document to render (default: 30)
      --no-cache           Don't reuse or store rendered Mermaid diagrams
  -q, --quiet              Only print errors
  -v, --version            Print the version
  -h, --help               Show this help

Options can also be set in front matter under "convpdf:", e.g.
  ---
  title: My Report
  convpdf: { toc: true, theme: serif, paper: Letter }
  ---
`;

const useColor = process.stderr.isTTY && !process.env['NO_COLOR'];
const c = {
  green: (s: string) => (useColor ? styleText('green', s) : s),
  yellow: (s: string) => (useColor ? styleText('yellow', s) : s),
  red: (s: string) => (useColor ? styleText('red', s) : s),
  dim: (s: string) => (useColor ? styleText('dim', s) : s),
  bold: (s: string) => (useColor ? styleText('bold', s) : s),
};

interface ResolvedInput {
  file: string | null; // null = stdin
  /** Folder the input was found under (for mirroring structure into an output folder). */
  root: string | null;
}

function expandInputs(args: string[]): ResolvedInput[] {
  const out: ResolvedInput[] = [];
  for (const arg of args) {
    if (arg === '-') {
      out.push({ file: null, root: null });
      continue;
    }
    const abs = resolve(arg);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) {
      const files = listMarkdown(abs);
      if (!files.length) throw new UsageError(`No markdown files found in ${arg}`);
      for (const f of files) out.push({ file: f, root: abs });
    } else if (stat?.isFile()) {
      out.push({ file: abs, root: null });
    } else if (/[*?[\]{}]/.test(arg)) {
      // Natural order, so chapter2.md comes before chapter10.md when merging.
      const matches = globSync(arg)
        .map((m) => resolve(m))
        .filter((m) => isMarkdownPath(m))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (!matches.length) throw new UsageError(`No files match ${arg}`);
      for (const f of matches) out.push({ file: f, root: null });
    } else {
      throw new UsageError(`File not found: ${arg}`);
    }
  }
  return out;
}

function withExt(file: string, ext: string): string {
  return join(dirname(file), basename(file, extname(file)) + ext);
}

/** Decide output paths: per-file, merged into one file, or mirrored into a folder. */
function planJobs(inputs: ResolvedInput[], output: string | undefined, format: 'pdf' | 'html'): Job[] {
  const ext = `.${format}`;
  const stdoutTarget = output === '-';
  const readStdin = (input: ResolvedInput) => (input.file === null ? { source: undefined } : { file: input.file });
  if (stdoutTarget && inputs.length > 1) {
    // Several inputs to stdout: merge.
    return [{ inputs: inputs.map(readStdin), output: null, format }];
  }
  const outIsFile = output !== undefined && !stdoutTarget && /\.(pdf|html?)$/i.test(output) && !(existsSync(output) && statSync(output).isDirectory());
  if (outIsFile) {
    if (inputs.length > 1) return [{ inputs: inputs.map(readStdin), output: resolve(output), format }];
    return [{ inputs: [readStdin(inputs[0]!)], output: resolve(output), format }];
  }
  if (stdoutTarget) return [{ inputs: [readStdin(inputs[0]!)], output: null, format }];

  const jobs: Job[] = [];
  const siblings = new Map<string, string>();
  for (const input of inputs) {
    let out: string | null;
    if (input.file === null) {
      out = output ? join(resolve(output), `stdin${ext}`) : process.stdout.isTTY ? resolve(`stdin${ext}`) : null;
    } else if (output) {
      const rel = input.root ? relative(input.root, input.file) : basename(input.file);
      out = withExt(join(resolve(output), rel), ext);
    } else {
      out = withExt(input.file, ext);
    }
    if (input.file && out) siblings.set(input.file, out);
    jobs.push({ inputs: [readStdin(input)], output: out, format });
  }
  for (const job of jobs) job.siblings = siblings;
  return jobs;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function display(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') ? rel : path;
}

function describe(job: Job): string {
  const files = job.inputs.map((i) => (i.file ? display(i.file) : 'stdin'));
  return files.length > 2 ? `${files[0]} + ${files.length - 1} more` : files.join(' + ');
}

function report(job: Job, result: JobResult, quiet: boolean): void {
  for (const w of result.warnings) process.stderr.write(`${c.yellow('warning')} ${w}\n`);
  if (quiet || !result.output) return;
  const detail = [result.pages ? `${result.pages} page${result.pages === 1 ? '' : 's'}` : '', `${Math.round(result.ms)} ms`].filter(Boolean).join(', ');
  process.stderr.write(`${c.green('✓')} ${describe(job)} ${c.dim('→')} ${display(result.output)} ${c.dim(`(${detail})`)}\n`);
}

function reportError(job: Job | null, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${c.red('✗')} ${job ? describe(job) + ': ' : ''}${message}\n`);
}

async function runConvert(argv: string[], browser?: Promise<Browser>): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      output: { type: 'string', short: 'o' },
      watch: { type: 'boolean', short: 'w' },
      open: { type: 'boolean' },
      html: { type: 'boolean' },
      theme: { type: 'string', short: 't' },
      css: { type: 'string', multiple: true },
      paper: { type: 'string', short: 'p' },
      'page-size': { type: 'string' },
      format: { type: 'string' },
      landscape: { type: 'boolean', short: 'l' },
      margin: { type: 'string', short: 'm' },
      'font-size': { type: 'string' },
      toc: { type: 'boolean' },
      'toc-depth': { type: 'string' },
      'toc-title': { type: 'string' },
      'break-before': { type: 'string' },
      header: { type: 'string' },
      footer: { type: 'string' },
      'page-numbers': { type: 'boolean' },
      'line-numbers': { type: 'boolean' },
      'code-theme': { type: 'string' },
      'mermaid-theme': { type: 'string' },
      breaks: { type: 'boolean' },
      frontmatter: { type: 'boolean' },
      'title-block': { type: 'boolean' },
      title: { type: 'string' },
      author: { type: 'string' },
      config: { type: 'string' },
      chrome: { type: 'string' },
      jobs: { type: 'string', short: 'j' },
      timeout: { type: 'string' },
      cache: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP.trimStart());
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  let inputArgs = positionals;
  if (!inputArgs.length) {
    if (process.stdin.isTTY) {
      process.stdout.write(HELP.trimStart());
      return 2;
    }
    inputArgs = ['-'];
  }
  const inputs = expandInputs(inputArgs);
  if (inputs.filter((i) => i.file === null).length > 1) throw new UsageError('stdin ("-") can only be used once');
  const format: 'pdf' | 'html' = values.html ? 'html' : 'pdf';
  const quiet = values.quiet ?? false;

  const cli: Partial<ConvertOptions> = {};
  const paper = values.paper ?? values['page-size'] ?? values.format;
  if (values.theme) cli.theme = THEME_NAMES.has(values.theme) ? values.theme : resolve(values.theme);
  if (values.css) cli.css = values.css.map((p) => resolve(p));
  if (paper) cli.paper = paper;
  if (values.landscape !== undefined) cli.landscape = values.landscape;
  if (values.margin) cli.margin = values.margin;
  if (values['font-size']) cli.fontSize = values['font-size'];
  if (values.toc !== undefined) cli.toc = values.toc;
  if (values['toc-depth']) cli.tocDepth = Number(values['toc-depth']);
  if (values['toc-title']) cli.tocTitle = values['toc-title'];
  if (values['break-before']) {
    const b = values['break-before'].toLowerCase();
    if (!['none', 'h1', 'h2'].includes(b)) throw new UsageError('--break-before must be h1, h2 or none');
    cli.breakBefore = b as ConvertOptions['breakBefore'];
  }
  if (values.header !== undefined) cli.header = values.header;
  if (values.footer !== undefined) cli.footer = values.footer;
  if (values['page-numbers'] === false && values.footer === undefined) cli.footer = '';
  if (values['line-numbers'] !== undefined) cli.lineNumbers = values['line-numbers'];
  if (values['code-theme']) cli.codeTheme = values['code-theme'];
  if (values['mermaid-theme']) cli.mermaidTheme = values['mermaid-theme'];
  if (values.breaks !== undefined) cli.breaks = values.breaks;
  if (values.frontmatter !== undefined) cli.showFrontmatter = values.frontmatter;
  if (values['title-block'] !== undefined) cli.titleBlock = values['title-block'];
  if (values.title) cli.title = values.title;
  if (values.author) cli.author = values.author;
  if (values.timeout) {
    const t = Number(values.timeout);
    if (!Number.isFinite(t) || t <= 0) throw new UsageError('--timeout must be a positive number of seconds');
    cli.timeout = t * 1000;
  }
  if (cli.tocDepth !== undefined && !(cli.tocDepth >= 1 && cli.tocDepth <= 6)) throw new UsageError('--toc-depth must be between 1 and 6');

  const warnings: string[] = [];
  const firstFile = inputs.find((i) => i.file)?.file;
  const configPath = values.config ? resolve(values.config) : findConfig(firstFile ? dirname(firstFile) : process.cwd());
  if (values.config && !existsSync(configPath!)) throw new UsageError(`Config file not found: ${values.config}`);
  const config = configPath ? await loadConfig(configPath, (m) => warnings.push(m)) : undefined;
  for (const w of warnings) process.stderr.write(`${c.yellow('warning')} ${w}\n`);

  const jobsArg = values.jobs ? Number(values.jobs) : Math.min(4, Math.max(1, cpus().length));
  const converter = new Converter({ cli, config, chrome: values.chrome, concurrency: jobsArg, browser, cache: values.cache === false ? false : undefined });
  const cleanup = () => converter.killSync();
  process.once('exit', cleanup);
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const jobs = planJobs(inputs, values.output, format);
  const stdinJob = jobs.find((j) => j.inputs.some((i) => !i.file));
  if (stdinJob) {
    if (format === 'pdf') converter.warmup();
    const text = await readStdin();
    for (const input of stdinJob.inputs) if (!input.file) input.source = text;
  }
  if (format === 'pdf') converter.warmup();

  let failures = 0;
  let opened = false;
  const runJob = async (job: Job): Promise<JobResult | null> => {
    try {
      const result = await converter.convert(job);
      if (!job.output) process.stdout.write(result.bytes);
      report(job, result, quiet);
      if (values.open && !opened && result.output) {
        opened = true;
        openTarget(result.output);
      }
      return result;
    } catch (err) {
      failures++;
      reportError(job, err);
      return null;
    }
  };

  const results = await Promise.all(jobs.map(runJob));

  if (values.watch) {
    if (stdinJob) throw new UsageError('--watch cannot be used with stdin');
    await watchJobs(jobs, results, runJob, inputs, values.output, format, quiet);
    return 0;
  }
  trace('closing browser');
  await converter.close();
  trace('closed');
  return failures ? 1 : 0;
}

const THEME_NAMES = new Set(themeNames());

/** Re-run jobs whenever one of their dependencies changes. */
async function watchJobs(
  jobs: Job[],
  initial: Array<JobResult | null>,
  runJob: (job: Job) => Promise<JobResult | null>,
  inputs: ResolvedInput[],
  output: string | undefined,
  format: 'pdf' | 'html',
  quiet: boolean,
): Promise<never> {
  const deps = new Map<Job, Set<string>>();
  const dirWatchers = new Map<string, FSWatcher>();
  const running = new Set<Job>();
  const dirty = new Set<Job>();
  const timers = new Map<Job, NodeJS.Timeout>();
  const known = new Set(jobs.flatMap((j) => j.inputs.map((i) => i.file!)));

  const rerun = async (job: Job) => {
    if (running.has(job)) {
      dirty.add(job);
      return;
    }
    running.add(job);
    const result = await runJob(job);
    running.delete(job);
    if (result) track(job, result.deps);
    if (dirty.delete(job)) void rerun(job);
  };

  const schedule = (job: Job) => {
    clearTimeout(timers.get(job));
    timers.set(job, setTimeout(() => void rerun(job), 60));
  };

  const onChange = (dir: string, name: string | null, event: string) => {
    if (!name) return;
    const full = join(dir, name);
    if (event === 'rename') Vault.invalidate();
    for (const [job, files] of deps) if (files.has(full)) schedule(job);
    // New markdown files inside watched input folders.
    if (event === 'rename' && isMarkdownPath(full) && !known.has(full) && existsSync(full)) {
      const root = inputs.find((i) => i.root && (full + sep).startsWith(i.root + sep))?.root;
      if (root) {
        known.add(full);
        const [job] = planJobs([{ file: full, root }], output, format);
        if (job) {
          job.siblings = jobs[0]?.siblings;
          jobs.push(job);
          void rerun(job);
        }
      }
    }
  };

  const watchDir = (dir: string, recursive = false) => {
    if (dirWatchers.has(dir)) return;
    try {
      const w = watch(dir, { recursive }, (event, name) => onChange(dir, name?.toString() ?? null, event));
      w.on('error', () => {});
      dirWatchers.set(dir, w);
    } catch {
      // directory vanished
    }
  };

  const track = (job: Job, files: Set<string>) => {
    deps.set(job, new Set(files));
    for (const f of files) watchDir(dirname(f));
  };

  jobs.forEach((job, i) => {
    const files = initial[i]?.deps ?? new Set(job.inputs.map((x) => x.file!).filter(Boolean));
    track(job, files);
  });
  for (const input of inputs) if (input.root) watchDir(input.root, true);

  if (!quiet) process.stderr.write(c.dim(`Watching for changes… (Ctrl+C to stop)\n`));
  return new Promise<never>(() => {});
}

/** Run the CLI; `browser` is a browser the entry point already started. */
export async function main(argv: string[], browser?: Promise<Browser>): Promise<number> {
  try {
    if (argv[0] === 'serve') {
      const { runServe } = await import('./server/server.ts');
      return await runServe(argv.slice(1));
    }
    return await runConvert(argv, browser);
  } catch (err) {
    if (err instanceof UsageError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`${c.red('error')} ${(err as Error).message}\n${c.dim('Run "convpdf --help" for usage.')}\n`);
      return 2;
    }
    reportError(null, err);
    return 1;
  }
}
