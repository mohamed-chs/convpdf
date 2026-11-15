import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { destinationPages, pageCount, setMetadata } from '../src/pdf/postprocess.ts';

/** Build a small, valid PDF with a classic xref table (the layout Skia produces). */
function makePdf(opts: { pages: number; dests?: Record<string, number>; nameTree?: boolean }): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) ; // object number = index + 1
  const pageNums: number[] = [];
  // 1: catalog, 2: pages, then pages, then dests
  add('PLACEHOLDER');
  add('PLACEHOLDER');
  for (let i = 0; i < opts.pages; i++) {
    add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>');
    pageNums.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${opts.pages} >>`;
  let catalogExtra = '';
  if (opts.dests) {
    const entries = Object.entries(opts.dests).map(([name, page]) => [name, `[${pageNums[page - 1]} 0 R /XYZ 0 792 0]`] as const);
    if (opts.nameTree) {
      add(`<< /Names [${entries.map(([n, d]) => `(${n}) ${d}`).join(' ')}] >>`);
      catalogExtra = ` /Names << /Dests ${objects.length} 0 R >>`;
    } else {
      add(`<< ${entries.map(([n, d]) => `/${n} ${d}`).join(' ')} >>`);
      catalogExtra = ` /Dests ${objects.length} 0 R`;
    }
  }
  objects[0] = `<< /Type /Catalog /Pages 2 0 R${catalogExtra} >>`;
  add('<< /Producer (Skia/PDF m157) /CreationDate (D:20260101000000+00\'00\') >>');
  const info = objects.length;

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('PDF post-processing', () => {
  it('counts pages', () => {
    assert.equal(pageCount(makePdf({ pages: 3 })), 3);
  });

  it('maps named destinations (Dests dictionary) to page numbers', () => {
    const pdf = makePdf({ pages: 3, dests: { intro: 1, 'details-1': 3 } });
    assert.deepEqual(Object.fromEntries(destinationPages(pdf)), { intro: 1, 'details-1': 3 });
  });

  it('maps named destinations in a name tree', () => {
    const pdf = makePdf({ pages: 2, dests: { a: 2 }, nameTree: true });
    assert.deepEqual(Object.fromEntries(destinationPages(pdf)), { a: 2 });
  });

  it('decodes #xx escapes in destination names', () => {
    const pdf = makePdf({ pages: 1, dests: { 'caf#C3#A9': 1 } });
    assert.deepEqual([...destinationPages(pdf).keys()], ['café']);
  });

  it('returns nothing for garbage input instead of throwing', () => {
    assert.equal(destinationPages(Buffer.from('not a pdf')).size, 0);
    assert.equal(pageCount(Buffer.from('')), 0);
    assert.equal(setMetadata(Buffer.from('nope'), { title: 'x' }).toString(), 'nope');
  });

  it('appends an incremental update with metadata', () => {
    const pdf = makePdf({ pages: 2, dests: { a: 2 } });
    const out = setMetadata(pdf, { title: 'Résumé (draft)', author: 'Ada', keywords: ['a', 'b'], creator: 'mdpdf', displayDocTitle: true });
    assert.ok(out.subarray(0, pdf.length).equals(pdf), 'original bytes are preserved');
    const tail = out.subarray(pdf.length).toString('latin1');
    assert.match(tail, /\/Title <FEFF0052/);
    assert.match(tail, /\/Author \(Ada\)/);
    assert.match(tail, /\/Keywords \(a, b\)/);
    assert.match(tail, /\/Producer \(Skia\/PDF m157\)/);
    assert.match(tail, /\/CreationDate/);
    assert.match(tail, /\/DisplayDocTitle true/);
    assert.match(tail, /\/Prev \d+/);
    // The updated file still parses: same pages and destinations.
    assert.equal(pageCount(out), 2);
    assert.deepEqual(Object.fromEntries(destinationPages(out)), { a: 2 });
  });

  it('escapes parentheses and backslashes in ASCII strings', () => {
    const out = setMetadata(makePdf({ pages: 1 }), { title: 'a (b) \\c' });
    assert.match(out.toString('latin1'), /\/Title \(a \\\(b\\\) \\\\c\)/);
  });
});
