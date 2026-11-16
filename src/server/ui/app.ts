/**
 * convpdf web UI: file list, editor, live preview and PDF export.
 */
import { createEditor } from './editor.ts';
import { Preview } from './preview.ts';

interface Boot {
  version: string;
  root: string;
  rootPath: string;
  initialFile: string | null;
  themes: string[];
  defaults: UiOptions;
  fonts: string;
}

interface UiOptions {
  theme?: string;
  paper?: string;
  landscape?: boolean;
  toc?: boolean;
  [key: string]: unknown;
}

interface RenderResponse {
  html: string;
  title: string;
  options: UiOptions;
  warnings: string[];
  ms: number;
}

type Mode = 'edit' | 'preview' | 'pdf';

const boot = (window as unknown as { __CONVPDF__: Boot }).__CONVPDF__;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- storage

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`convpdf:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(`convpdf:${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable
  }
}

// ---------------------------------------------------------------- state

const state = {
  files: [] as string[],
  path: null as string | null,
  /** Display name for documents that are not files in the folder (dropped / new). */
  scratchName: 'Untitled.md',
  savedText: '',
  overrides: load<UiOptions>('overrides', {}),
  effective: { ...boot.defaults } as UiOptions,
  mode: 'preview' as Mode,
  warnings: [] as string[],
  diagramWarnings: [] as string[],
  collapsed: new Set<string>(load<string[]>('collapsed', [])),
  renderSeq: 0,
  pdf: { url: '', key: '', seq: 0 },
  lastRenderMs: 30,
  changedOnDisk: false,
};

// ---------------------------------------------------------------- api

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET') headers.set('X-Convpdf', '1');
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  return res;
}

function requestBody(): string {
  return JSON.stringify({ path: state.path, source: editor.getText(), options: state.overrides });
}

// ---------------------------------------------------------------- fonts

if (boot.fonts) {
  const style = document.createElement('style');
  style.textContent = boot.fonts;
  document.head.append(style);
}

// ---------------------------------------------------------------- editor & preview

const editor = createEditor($('editor'), {
  onChange() {
    updateDirty();
    scheduleRender();
  },
  onScroll() {
    if (scrollLead === 'editor') syncScroll('editor');
  },
});

// Handy for debugging and automated UI checks.
(window as unknown as { __convpdfEditor: typeof editor }).__convpdfEditor = editor;

const preview = new Preview($<HTMLIFrameElement>('preview'), {
  onScroll() {
    if (scrollLead === 'preview') syncScroll('preview');
  },
  onLink: openLink,
  onDiagramWarning(message) {
    state.diagramWarnings = [...new Set([...state.diagramWarnings, `Mermaid: ${message}`])];
    showWarnings();
  },
});

// Which pane drives scroll sync: the one the pointer is over.
let scrollLead: 'editor' | 'preview' = 'editor';
$('editor').addEventListener('pointerenter', () => (scrollLead = 'editor'));
$('editor').addEventListener('focusin', () => (scrollLead = 'editor'));
$('preview-pane').addEventListener('pointerenter', () => (scrollLead = 'preview'));

let syncFrame = 0;
function syncScroll(from: 'editor' | 'preview'): void {
  cancelAnimationFrame(syncFrame);
  syncFrame = requestAnimationFrame(() => {
    if (from === 'editor') preview.scrollToLine(editor.topLine());
    else editor.scrollToLine(preview.topLine());
  });
}

function openLink(href: string): void {
  const url = new URL(href, location.href);
  if (url.origin === location.origin && url.pathname.startsWith('/fs/')) {
    const abs = decodeURIComponent(url.pathname.slice(3));
    const root = boot.rootPath.replace(/\\/g, '/');
    const rel = abs.startsWith(root + '/') ? abs.slice(root.length + 1) : null;
    if (rel && /\.(md|markdown|mdown|mkd)$/i.test(rel)) {
      void openFile(rel);
      return;
    }
  }
  window.open(url.href, '_blank', 'noopener');
}

// ---------------------------------------------------------------- rendering

let renderTimer = 0;
let pdfTimer = 0;
let renderAbort: AbortController | null = null;

function scheduleRender(immediate = false): void {
  clearTimeout(renderTimer);
  // Debounce relative to how long rendering takes, so big documents stay smooth.
  const delay = immediate ? 0 : Math.min(400, Math.max(60, state.lastRenderMs * 1.5));
  renderTimer = window.setTimeout(render, delay);
  if (state.mode === 'pdf') schedulePdf();
}

async function render(): Promise<void> {
  renderAbort?.abort();
  const abort = new AbortController();
  renderAbort = abort;
  const seq = ++state.renderSeq;
  const start = performance.now();
  try {
    const res = await api('/api/render', { method: 'POST', body: requestBody(), signal: abort.signal, headers: { 'content-type': 'application/json' } });
    const data = (await res.json()) as RenderResponse;
    if (seq !== state.renderSeq) return;
    state.lastRenderMs = performance.now() - start;
    state.effective = data.options;
    state.warnings = data.warnings;
    state.diagramWarnings = [];
    syncControls();
    showError(null);
    await preview.update(data.html);
    showWarnings();
    setRenderStatus(`Rendered in ${data.ms} ms`);
    document.title = `${displayName()} · convpdf`;
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    showError((err as Error).message);
  }
}

function pdfKey(): string {
  return requestBody();
}

function schedulePdf(delay = 500): void {
  clearTimeout(pdfTimer);
  pdfTimer = window.setTimeout(() => void renderPdf(), delay);
}

async function fetchPdf(): Promise<{ url: string; pages: number; ms: number; warnings: string[] }> {
  const key = pdfKey();
  const res = await api('/api/pdf', { method: 'POST', body: key, headers: { 'content-type': 'application/json' } });
  const blob = await res.blob();
  const warnings = JSON.parse(decodeURIComponent(res.headers.get('x-warnings') ?? '%5B%5D')) as string[];
  if (state.pdf.url) URL.revokeObjectURL(state.pdf.url);
  state.pdf.url = URL.createObjectURL(blob);
  state.pdf.key = key;
  return { url: state.pdf.url, pages: Number(res.headers.get('x-pages') ?? 0), ms: Number(res.headers.get('x-ms') ?? 0), warnings };
}

async function renderPdf(): Promise<void> {
  if (state.pdf.key === pdfKey() && state.pdf.url) return;
  const seq = ++state.pdf.seq;
  setBusy('Rendering PDF');
  try {
    const result = await fetchPdf();
    if (seq !== state.pdf.seq) return;
    $<HTMLIFrameElement>('pdf').src = `${result.url}#view=FitH&navpanes=0`;
    state.warnings = result.warnings;
    showWarnings();
    showError(null);
    setRenderStatus(`PDF: ${result.pages} ${result.pages === 1 ? 'page' : 'pages'} in ${result.ms} ms`);
  } catch (err) {
    showError((err as Error).message);
  } finally {
    if (seq === state.pdf.seq) setBusy(null);
  }
}

async function downloadPdf(): Promise<void> {
  const button = $<HTMLButtonElement>('download');
  button.disabled = true;
  try {
    if (state.pdf.key !== pdfKey() || !state.pdf.url) {
      setBusy('Preparing PDF');
      await fetchPdf();
    }
    const a = document.createElement('a');
    a.href = state.pdf.url;
    a.download = displayName().replace(/\.(md|markdown|mdown|mkd)$/i, '') + '.pdf';
    document.body.append(a);
    a.click();
    a.remove();
  } catch (err) {
    showError((err as Error).message);
  } finally {
    setBusy(null);
    button.disabled = false;
  }
}

// ---------------------------------------------------------------- status & errors

function setBusy(text: string | null): void {
  $('busy').hidden = text === null;
  if (text) $('busy-text').textContent = text;
}

function showError(message: string | null): void {
  const el = $('error');
  el.hidden = !message;
  el.textContent = message ?? '';
}

function setRenderStatus(text: string): void {
  $('status-render').textContent = text;
}

function showWarnings(): void {
  const all = [...state.warnings, ...state.diagramWarnings];
  const button = $('status-warnings');
  button.hidden = all.length === 0;
  button.textContent = `${all.length} ${all.length === 1 ? 'warning' : 'warnings'}`;
  const list = $('warnings-list');
  list.replaceChildren(
    ...all.map((w) => {
      const li = document.createElement('li');
      li.textContent = w;
      return li;
    }),
  );
  if (!all.length) $('warnings-panel').hidden = true;
}

function displayName(): string {
  return state.path ?? state.scratchName;
}

function updateDirty(): void {
  const dirty = editor.getText() !== state.savedText;
  $('dirty').hidden = !dirty;
  const status = $('status-file');
  if (state.changedOnDisk) {
    status.innerHTML = '';
    status.append('Changed on disk · ');
    const reload = document.createElement('button');
    reload.className = 'link-btn';
    reload.textContent = 'Reload';
    reload.onclick = () => void openFile(state.path!, true);
    status.append(reload);
  } else {
    status.textContent = dirty ? (state.path ? 'Unsaved changes · Ctrl+S to save' : 'Not saved') : state.path ? 'Saved' : '';
  }
}

function setDocName(): void {
  const name = displayName();
  $('doc-path').textContent = name;
  $('doc-path').parentElement!.title = name;
}

// ---------------------------------------------------------------- files

async function loadFiles(): Promise<void> {
  const res = await api('/api/files');
  const data = (await res.json()) as { root: string; files: string[] };
  state.files = data.files;
  renderTree();
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file: boolean;
}

function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), file: false };
  for (const file of files) {
    let node = root;
    const parts = file.split('/');
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, children: new Map(), file: isFile };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

const ICON_FILE = '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const ICON_CHEVRON = '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>';

function renderTree(): void {
  const filter = $<HTMLInputElement>('filter').value.trim().toLowerCase();
  const files = filter ? state.files.filter((f) => f.toLowerCase().includes(filter)) : state.files;
  const tree = $('tree');
  tree.replaceChildren();
  if (!files.length) {
    const empty = document.createElement('p');
    empty.className = 'tree-empty';
    empty.textContent = state.files.length ? 'No matching files' : 'No Markdown files yet';
    tree.append(empty);
    return;
  }
  const list = (node: TreeNode, depth: number): HTMLUListElement => {
    const ul = document.createElement('ul');
    const entries = [...node.children.values()].sort((a, b) =>
      a.file === b.file ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.file ? 1 : -1,
    );
    for (const child of entries) {
      const li = document.createElement('li');
      const row = document.createElement('button');
      row.className = 'tree-row';
      row.style.setProperty('--depth', String(depth));
      if (child.file) {
        row.innerHTML = ICON_FILE;
        row.append(child.name.replace(/\.(md|markdown|mdown|mkd)$/i, ''));
        row.title = child.path;
        if (child.path === state.path) row.classList.add('active');
        row.onclick = () => void openFile(child.path);
        li.append(row);
      } else {
        const collapsed = !filter && state.collapsed.has(child.path);
        row.classList.add('folder');
        row.setAttribute('aria-expanded', String(!collapsed));
        row.innerHTML = ICON_CHEVRON;
        row.append(child.name);
        row.onclick = () => {
          if (state.collapsed.has(child.path)) state.collapsed.delete(child.path);
          else state.collapsed.add(child.path);
          save('collapsed', [...state.collapsed]);
          renderTree();
        };
        li.append(row);
        if (!collapsed) li.append(list(child, depth + 1));
      }
      ul.append(li);
    }
    return ul;
  };
  tree.append(list(buildTree(files), 0));
}

function confirmDiscard(): boolean {
  return editor.getText() === state.savedText || confirm('Discard unsaved changes?');
}

async function openFile(path: string, force = false): Promise<void> {
  if (!force && path === state.path) return;
  if (!force && !confirmDiscard()) return;
  try {
    const res = await api(`/api/file?path=${encodeURIComponent(path)}`);
    const text = await res.text();
    const sameFile = path === state.path;
    state.path = path;
    state.savedText = text;
    state.changedOnDisk = false;
    state.pdf.key = '';
    editor.setText(text, !sameFile);
    if (!sameFile) editor.scrollToLine(0);
    setDocName();
    updateDirty();
    renderTree();
    save('lastFile', path);
    history.replaceState(null, '', `#${encodeURIComponent(path)}`);
    scheduleRender(true);
    if (state.mode === 'pdf') schedulePdf(0);
  } catch (err) {
    showError((err as Error).message);
  }
}

function openScratch(name: string, text: string): void {
  state.path = null;
  state.scratchName = name;
  state.savedText = '';
  state.changedOnDisk = false;
  editor.setText(text, true);
  setDocName();
  updateDirty();
  renderTree();
  history.replaceState(null, '', location.pathname);
  scheduleRender(true);
}

async function saveFile(): Promise<void> {
  let path = state.path;
  if (!path) {
    const name = prompt('Save as (path inside the folder):', state.scratchName);
    if (!name) return;
    path = /\.(md|markdown|mdown|mkd)$/i.test(name) ? name : `${name}.md`;
  }
  const text = editor.getText();
  try {
    await api(`/api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: text, headers: { 'content-type': 'text/markdown' } });
    const isNew = path !== state.path;
    state.path = path;
    state.savedText = text;
    state.changedOnDisk = false;
    setDocName();
    updateDirty();
    if (isNew) {
      await loadFiles();
      history.replaceState(null, '', `#${encodeURIComponent(path)}`);
      scheduleRender(true);
    }
  } catch (err) {
    showError(`Could not save: ${(err as Error).message}`);
  }
}

async function newFile(): Promise<void> {
  if (!confirmDiscard()) return;
  const name = prompt('New file name:', 'Untitled.md');
  if (!name) return;
  const path = /\.(md|markdown|mdown|mkd)$/i.test(name) ? name : `${name}.md`;
  if (state.files.includes(path)) {
    await openFile(path);
    return;
  }
  const title = path.split('/').pop()!.replace(/\.[^.]+$/, '');
  try {
    await api(`/api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: `# ${title}\n\n`, headers: { 'content-type': 'text/markdown' } });
    await loadFiles();
    await openFile(path, true);
    editor.focus();
  } catch (err) {
    showError((err as Error).message);
  }
}

// ---------------------------------------------------------------- live updates

function connectEvents(): void {
  const events = new EventSource('/api/events');
  let treeTimer = 0;
  events.onmessage = (e) => {
    const msg = JSON.parse(e.data as string) as { type: 'change' | 'tree'; path: string; exists: boolean };
    if (msg.type === 'tree' || /\.(md|markdown|mdown|mkd)$/i.test(msg.path)) {
      clearTimeout(treeTimer);
      treeTimer = window.setTimeout(() => void loadFiles(), 150);
    }
    if (msg.path === state.path && msg.exists) {
      void reloadIfChanged();
    } else {
      // Possibly an embedded note, image or stylesheet of the current document.
      state.pdf.key = '';
      scheduleRender();
    }
  };
}

async function reloadIfChanged(): Promise<void> {
  if (!state.path) return;
  const res = await api(`/api/file?path=${encodeURIComponent(state.path)}`).catch(() => null);
  if (!res) return;
  const text = await res.text();
  if (text === state.savedText) return;
  if (editor.getText() === state.savedText) {
    state.savedText = text;
    editor.setText(text);
    updateDirty();
  } else {
    state.changedOnDisk = true;
    updateDirty();
  }
}

// ---------------------------------------------------------------- controls

function syncControls(): void {
  const theme = $<HTMLSelectElement>('opt-theme');
  const value = String(state.effective.theme ?? 'default');
  if (![...theme.options].some((o) => o.value === value)) theme.append(new Option(value.split(/[\\/]/).pop()!, value));
  theme.value = value;

  const paper = $<HTMLSelectElement>('opt-paper');
  const p = String(state.effective.paper ?? 'A4');
  const match = [...paper.options].find((o) => o.value.toLowerCase() === p.toLowerCase());
  if (match) paper.value = match.value;
  else {
    paper.append(new Option(p, p));
    paper.value = p;
  }
  $('opt-landscape').setAttribute('aria-pressed', String(!!state.effective.landscape));
  $('opt-toc').setAttribute('aria-pressed', String(!!state.effective.toc));
}

function setOverride(key: string, value: unknown): void {
  state.overrides = { ...state.overrides, [key]: value };
  state.effective = { ...state.effective, [key]: value };
  save('overrides', state.overrides);
  syncControls();
  scheduleRender(true);
}

function initControls(): void {
  const theme = $<HTMLSelectElement>('opt-theme');
  for (const name of boot.themes) theme.append(new Option(name.charAt(0).toUpperCase() + name.slice(1), name));
  theme.onchange = () => setOverride('theme', theme.value);
  const paper = $<HTMLSelectElement>('opt-paper');
  paper.onchange = () => setOverride('paper', paper.value);
  $('opt-landscape').onclick = () => setOverride('landscape', !state.effective.landscape);
  $('opt-toc').onclick = () => setOverride('toc', !state.effective.toc);
  syncControls();
}

// ---------------------------------------------------------------- layout

function setMode(mode: Mode): void {
  state.mode = mode;
  document.body.dataset['mode'] = mode;
  for (const m of ['edit', 'preview', 'pdf'] as const) $(`mode-${m}`).setAttribute('aria-selected', String(m === mode));
  $('preview').hidden = mode === 'pdf';
  $('pdf').hidden = mode !== 'pdf';
  if (mode === 'pdf') void renderPdf();
  else setBusy(null);
}

function initLayout(): void {
  const app = $('app');
  const setSidebar = (open: boolean) => {
    app.classList.toggle('sidebar-closed', !open);
    save('sidebar', open);
  };
  setSidebar(load('sidebar', window.innerWidth > 1100));
  $('toggle-sidebar').onclick = () => setSidebar(app.classList.contains('sidebar-closed'));

  const workspace = $('workspace');
  const setSplit = (ratio: number) => {
    const r = Math.min(0.8, Math.max(0.2, ratio));
    workspace.style.setProperty('--split', String(r));
    return r;
  };
  setSplit(load('split', 0.5));
  const splitter = $('splitter');
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const rect = workspace.getBoundingClientRect();
    const move = (ev: PointerEvent) => setSplit((ev.clientX - rect.left) / rect.width);
    const up = (ev: PointerEvent) => {
      splitter.releasePointerCapture(ev.pointerId);
      splitter.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing');
      save('split', setSplit((ev.clientX - rect.left) / rect.width));
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up, { once: true });
  });
  splitter.addEventListener('dblclick', () => save('split', setSplit(0.5)));

  $('mode-edit').onclick = () => setMode('edit');
  $('mode-preview').onclick = () => setMode('preview');
  $('mode-pdf').onclick = () => setMode('pdf');
  $('download').onclick = () => void downloadPdf();
  $('new-file').onclick = () => void newFile();
  $('filter').oninput = renderTree;
  $('status-warnings').onclick = () => ($('warnings-panel').hidden = !$('warnings-panel').hidden);
  $('close-warnings').onclick = () => ($('warnings-panel').hidden = true);
  $('root-name').textContent = boot.root;

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 's') {
      e.preventDefault();
      void saveFile();
    } else if (key === 'e') {
      e.preventDefault();
      void downloadPdf();
    } else if (key === 'b') {
      e.preventDefault();
      setSidebar(app.classList.contains('sidebar-closed'));
    } else if (key === 'p' && e.shiftKey) {
      e.preventDefault();
      setMode(state.mode === 'pdf' ? 'preview' : 'pdf');
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.path && editor.getText() !== state.savedText) e.preventDefault();
  });

  // Drag and drop a markdown file to open it.
  let dragDepth = 0;
  const drop = $('drop');
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    dragDepth++;
    drop.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) drop.hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    drop.hidden = true;
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    if (!/\.(md|markdown|mdown|mkd|txt)$/i.test(file.name)) {
      showError(`${file.name} is not a Markdown file`);
      return;
    }
    if (!confirmDiscard()) return;
    void file.text().then((text) => openScratch(file.name, text));
  });
}

// ---------------------------------------------------------------- start

async function start(): Promise<void> {
  initLayout();
  initControls();
  setMode(window.innerWidth < 800 ? 'edit' : 'preview');
  connectEvents();
  await loadFiles().catch((err: Error) => showError(err.message));
  const fromHash = location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
  const candidates = [fromHash, boot.initialFile, load<string | null>('lastFile', null)];
  const first = candidates.find((c): c is string => !!c && state.files.includes(c)) ?? state.files.find((f) => /(^|\/)(readme|index)\.md$/i.test(f)) ?? state.files[0];
  if (first) await openFile(first, true);
  else openScratch('Untitled.md', WELCOME);
  editor.focus();
}

const WELCOME = `# Welcome to convpdf

Write Markdown on the left and see the result on the right.
Switch to **PDF** above to see the exact output, or press **Ctrl+E** to download it.

> [!TIP]
> Everything GitHub and Obsidian support works: tables, task lists, footnotes,
> callouts, math like $e^{i\\pi} + 1 = 0$, Mermaid diagrams, wikilinks and embeds.

- [x] Live preview
- [ ] Save with **Ctrl+S**
`;

void start();
