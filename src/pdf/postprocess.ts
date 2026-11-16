/**
 * Lightweight PDF post-processing for Chrome (Skia) generated files.
 *
 * We avoid a full PDF library: Skia writes an uncompressed classic xref table
 * and plain-text dictionaries for the catalog, page tree and destinations,
 * which is all we need to:
 *
 *  - map named destinations (element ids that are link targets) to page
 *    numbers, used to fill in table-of-contents page numbers, and
 *  - append an incremental update that sets document metadata (author,
 *    subject, keywords...) and viewer preferences.
 *
 * Everything degrades gracefully: if the file is not in the expected shape we
 * return the input unchanged.
 */

interface XrefInfo {
  offsets: Map<number, number>;
  root: string | null;
  info: string | null;
  id: string | null;
  size: number;
  startxref: number;
}

function parseXref(text: string): XrefInfo | null {
  const sx = text.lastIndexOf('startxref');
  if (sx === -1) return null;
  const startxref = Number(/startxref\s+(\d+)/.exec(text.slice(sx, sx + 40))?.[1]);
  if (!Number.isFinite(startxref)) return null;
  const offsets = new Map<number, number>();
  let root: string | null = null;
  let info: string | null = null;
  let id: string | null = null;
  let size = 0;
  let pos: number | null = startxref;
  const seen = new Set<number>();
  while (pos !== null && !seen.has(pos)) {
    seen.add(pos);
    if (text.slice(pos, pos + 4) !== 'xref') return null; // xref streams are not supported
    let i = pos + 4;
    const lineRe = /\s*(\d+)\s+(\d+)\s*/y;
    for (;;) {
      lineRe.lastIndex = i;
      const header = lineRe.exec(text);
      if (!header) break;
      const first = Number(header[1]);
      const count = Number(header[2]);
      i = lineRe.lastIndex;
      for (let n = 0; n < count; n++) {
        const entry = text.slice(i, i + 20);
        const m = /^(\d{10}) (\d{5}) ([nf])/.exec(entry);
        if (!m) return null;
        const num = first + n;
        if (m[3] === 'n' && !offsets.has(num)) offsets.set(num, Number(m[1]));
        i += 20;
      }
    }
    const trailerIdx = text.indexOf('trailer', i);
    if (trailerIdx === -1) return null;
    const trailer = text.slice(trailerIdx, text.indexOf('startxref', trailerIdx));
    root ??= /\/Root\s+(\d+\s+\d+\s+R)/.exec(trailer)?.[1] ?? null;
    info ??= /\/Info\s+(\d+\s+\d+\s+R)/.exec(trailer)?.[1] ?? null;
    id ??= /\/ID\s*(\[[^\]]*\])/.exec(trailer)?.[1] ?? null;
    size = Math.max(size, Number(/\/Size\s+(\d+)/.exec(trailer)?.[1] ?? 0));
    const prev = /\/Prev\s+(\d+)/.exec(trailer);
    pos = prev ? Number(prev[1]) : null;
  }
  return { offsets, root, info, id, size, startxref };
}

class PdfReader {
  readonly text: string;
  readonly xref: XrefInfo;

  constructor(text: string, xref: XrefInfo) {
    this.text = text;
    this.xref = xref;
  }

  static from(pdf: Buffer): PdfReader | null {
    const text = pdf.toString('latin1');
    const xref = parseXref(text);
    return xref ? new PdfReader(text, xref) : null;
  }

  /** Raw source of an object's value (between `obj` and `endobj`). */
  object(ref: string | number): string | null {
    const num = typeof ref === 'number' ? ref : Number(ref.trim().split(/\s+/)[0]);
    const off = this.xref.offsets.get(num);
    if (off === undefined) return null;
    const start = this.text.indexOf('obj', off);
    if (start === -1) return null;
    let end = this.text.indexOf('endobj', start);
    if (end === -1) return null;
    const stream = this.text.indexOf('stream', start);
    if (stream !== -1 && stream < end) end = stream;
    return this.text.slice(start + 3, end).trim();
  }

  /** Page object numbers in document order. */
  pages(): number[] {
    const catalog = this.xref.root ? this.object(this.xref.root) : null;
    const pagesRef = catalog && /\/Pages\s+(\d+)\s+\d+\s+R/.exec(catalog)?.[1];
    if (!pagesRef) return [];
    const out: number[] = [];
    const walk = (num: number, depth: number) => {
      if (depth > 64) return;
      const node = this.object(num);
      if (!node) return;
      if (/\/Type\s*\/Pages\b/.test(node)) {
        const kids = /\/Kids\s*\[([^\]]*)\]/.exec(node)?.[1] ?? '';
        for (const m of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(m[1]), depth + 1);
      } else {
        out.push(num);
      }
    };
    walk(Number(pagesRef), 0);
    return out;
  }

  /** Named destinations → target page object number. */
  namedDestinations(): Map<string, number> {
    const result = new Map<string, number>();
    const catalog = this.xref.root ? this.object(this.xref.root) : null;
    if (!catalog) return result;
    const resolveDest = (value: string): number | null => {
      const direct = /^\[\s*(\d+)\s+\d+\s+R/.exec(value);
      if (direct) return Number(direct[1]);
      const ref = /^(\d+)\s+\d+\s+R/.exec(value);
      if (ref) {
        const obj = this.object(Number(ref[1]));
        if (!obj) return null;
        const inner = /^\[\s*(\d+)\s+\d+\s+R/.exec(obj) ?? /\/D\s*\[\s*(\d+)\s+\d+\s+R/.exec(obj);
        return inner ? Number(inner[1]) : null;
      }
      return null;
    };
    // PDF 1.1 style: /Dests dictionary in the catalog.
    const destsRef = /\/Dests\s+(\d+)\s+\d+\s+R/.exec(catalog)?.[1];
    if (destsRef) {
      const dict = this.object(Number(destsRef)) ?? '';
      const re = /\/((?:[^\s/[\]<>(){}%#]|#[0-9A-Fa-f]{2})+)\s*(\[\s*\d+\s+\d+\s+R|\d+\s+\d+\s+R)/g;
      for (const m of dict.matchAll(re)) {
        const page = resolveDest(m[2]!);
        if (page !== null) result.set(decodeName(m[1]!), page);
      }
    }
    // PDF 1.2+ style: name tree under /Names /Dests.
    const namesRef = /\/Names\s+(\d+)\s+\d+\s+R/.exec(catalog)?.[1];
    const namesDict = namesRef ? this.object(Number(namesRef)) : /\/Names\s*<<([\s\S]*?)>>/.exec(catalog)?.[1];
    const treeRef = namesDict ? /\/Dests\s+(\d+)\s+\d+\s+R/.exec(namesDict)?.[1] : undefined;
    if (treeRef) {
      const walk = (num: number, depth: number) => {
        if (depth > 32) return;
        const node = this.object(num);
        if (!node) return;
        const kids = /\/Kids\s*\[([^\]]*)\]/.exec(node)?.[1];
        if (kids) for (const m of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(m[1]), depth + 1);
        const names = /\/Names\s*\[([\s\S]*)\]/.exec(node)?.[1];
        if (names) {
          const re = /(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)\s*(\[\s*\d+\s+\d+\s+R|\d+\s+\d+\s+R)/g;
          for (const m of names.matchAll(re)) {
            const page = resolveDest(m[2]!);
            if (page !== null) result.set(decodeString(m[1]!), page);
          }
        }
      };
      walk(Number(treeRef), 0);
    }
    return result;
  }
}

function decodeName(name: string): string {
  const bytes = name.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

function decodeString(s: string): string {
  let bytes: Buffer;
  if (s.startsWith('<')) {
    bytes = Buffer.from(s.slice(1, -1).replace(/\s+/g, ''), 'hex');
  } else {
    const body = s.slice(1, -1).replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) => {
      const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      return map[e] ?? String.fromCharCode(parseInt(e, 8));
    });
    bytes = Buffer.from(body, 'latin1');
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return bytes.subarray(2).swap16().toString('utf16le');
  return bytes.toString('utf8');
}

/** Map every named destination to its 1-based page number. */
export function destinationPages(pdf: Buffer): Map<string, number> {
  const reader = PdfReader.from(pdf);
  const out = new Map<string, number>();
  if (!reader) return out;
  const pageIndex = new Map(reader.pages().map((num, i) => [num, i + 1]));
  for (const [name, pageObj] of reader.namedDestinations()) {
    const page = pageIndex.get(pageObj);
    if (page !== undefined) out.set(name, page);
  }
  return out;
}

export function pageCount(pdf: Buffer): number {
  return PdfReader.from(pdf)?.pages().length ?? 0;
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  /** Show the title (not the file name) in viewer window title bars. */
  displayDocTitle?: boolean;
}

/** Encode a PDF text string: literal for printable ASCII, UTF-16BE hex otherwise. */
function pdfString(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return `(${value.replace(/[\\()]/g, (c) => '\\' + c)})`;
  const utf16 = Buffer.from(value, 'utf16le').swap16();
  return `<FEFF${utf16.toString('hex').toUpperCase()}>`;
}

/**
 * Append an incremental update setting the document information dictionary.
 * Existing entries (e.g. creation date) are preserved unless overridden.
 */
export function setMetadata(pdf: Buffer, meta: PdfMetadata): Buffer {
  const reader = PdfReader.from(pdf);
  if (!reader || !reader.xref.root) return pdf;
  const { xref } = reader;
  const originalRoot = reader.xref.root;

  const entries = new Map<string, string>();
  const oldInfo = xref.info ? reader.object(xref.info) : null;
  if (oldInfo) {
    for (const key of ['CreationDate', 'ModDate']) {
      const m = new RegExp(`/${key}\\s*(\\([^)]*\\))`).exec(oldInfo);
      if (m) entries.set(key, m[1]!);
    }
    if (!meta.producer) {
      const p = /\/Producer\s*(\([^)]*\))/.exec(oldInfo);
      if (p) entries.set('Producer', p[1]!);
    }
  }
  if (meta.title) entries.set('Title', pdfString(meta.title));
  if (meta.author) entries.set('Author', pdfString(meta.author));
  if (meta.subject) entries.set('Subject', pdfString(meta.subject));
  if (meta.keywords?.length) entries.set('Keywords', pdfString(meta.keywords.join(', ')));
  if (meta.creator) entries.set('Creator', pdfString(meta.creator));
  if (meta.producer) entries.set('Producer', pdfString(meta.producer));

  const objects: Array<[number, string]> = [];
  let next = xref.size;
  const infoNum = next++;
  objects.push([infoNum, `<<${[...entries].map(([k, v]) => `/${k} ${v}`).join(' ')}>>`]);

  let rootRef = originalRoot;
  if (meta.displayDocTitle) {
    const catalog = reader.object(originalRoot);
    if (catalog && catalog.startsWith('<<') && !/\/ViewerPreferences/.test(catalog)) {
      const rootNum = Number(originalRoot.split(/\s+/)[0]);
      const gen = originalRoot.split(/\s+/)[1] ?? '0';
      if (gen === '0') {
        objects.push([rootNum, catalog.replace(/>>\s*$/, '/ViewerPreferences <</DisplayDocTitle true>>\n>>')]);
        rootRef = `${rootNum} 0 R`;
      }
    }
  }

  let body = '\n';
  const offsets: Array<[number, number]> = [];
  for (const [num, value] of objects) {
    offsets.push([num, pdf.length + Buffer.byteLength(body, 'latin1')]);
    body += `${num} 0 obj\n${value}\nendobj\n`;
  }
  const xrefOffset = pdf.length + Buffer.byteLength(body, 'latin1');
  let table = 'xref\n';
  for (const [num, off] of offsets.sort((a, b) => a[0] - b[0])) {
    table += `${num} 1\n${String(off).padStart(10, '0')} 00000 n \n`;
  }
  const trailer =
    `trailer\n<</Size ${next} /Root ${rootRef} /Info ${infoNum} 0 R` +
    (xref.id ? ` /ID ${xref.id}` : '') +
    ` /Prev ${xref.startxref}>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.concat([pdf, Buffer.from(body + table + trailer, 'latin1')]);
}
