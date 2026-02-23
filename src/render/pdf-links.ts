import { readFile, writeFile } from 'fs/promises';
import { relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, PDFName, PDFDict, PDFString, PDFHexString } from 'pdf-lib';
import { SOURCE_ROUTE_PREFIX } from './server.js';

const FILE_URI_MARKER = 'file:///';
const FILE_URI_HEX_MARKER = '66696c653a2f2f2f';
const SOURCE_ROUTE_HEX_MARKER = '2f5f5f636f6e767064665f736f757263652f';

const normalizeRelativeHref = (basePath: string, targetPath: string, suffix: string): string => {
  let relPath = relative(resolve(basePath), targetPath).split('\\').join('/');
  if (!relPath) relPath = '.';
  if (!relPath.startsWith('.') && !relPath.startsWith('/')) {
    relPath = `./${relPath}`;
  }
  return `${relPath}${suffix}`;
};

const toRelativeHrefFromFileUrl = (href: string, basePath: string): string | null => {
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== 'file:') return null;
    const targetPath = fileURLToPath(parsed);
    return normalizeRelativeHref(basePath, targetPath, `${parsed.search}${parsed.hash}`);
  } catch {
    return null;
  }
};

const toRelativeHrefFromServerUrl = (
  href: string,
  basePath: string,
  renderServerBaseUrl: string
): string | null => {
  try {
    const parsed = new URL(href);
    const serverBase = new URL(renderServerBaseUrl);
    if (parsed.origin !== serverBase.origin) return null;

    if (!parsed.pathname.startsWith(SOURCE_ROUTE_PREFIX)) return null;

    const sourcePathWithKey = parsed.pathname.slice(SOURCE_ROUTE_PREFIX.length);
    const separatorIndex = sourcePathWithKey.indexOf('/');
    if (separatorIndex < 0) return null;
    const sourceRelative = decodeURIComponent(sourcePathWithKey.slice(separatorIndex + 1));
    const targetPath = resolve(basePath, sourceRelative);
    return normalizeRelativeHref(basePath, targetPath, `${parsed.search}${parsed.hash}`);
  } catch {
    return null;
  }
};

export const rewritePdfFileUrisToRelative = async (
  outputPath: string,
  basePath: string,
  renderServerBaseUrl?: string
): Promise<void> => {
  // Parse the full PDF to handle both PDFString and PDFHexString-encoded URIs.
  // Byte-scanning for '/URI (file:///' would miss hex-encoded annotations.
  // We rely on the `!changed` guard below to avoid re-saving when unneeded.
  const pdfBytes = await readFile(outputPath);
  const pdfText = pdfBytes.toString('latin1').toLowerCase();
  const hasFileUriCandidate =
    pdfText.includes(FILE_URI_MARKER) || pdfText.includes(FILE_URI_HEX_MARKER);
  const hasServerUriCandidate =
    Boolean(renderServerBaseUrl) &&
    (pdfText.includes(SOURCE_ROUTE_PREFIX) || pdfText.includes(SOURCE_ROUTE_HEX_MARKER));
  if (!hasFileUriCandidate && !hasServerUriCandidate) {
    return;
  }

  const pdfDocument = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const actionKey = PDFName.of('A');
  const uriKey = PDFName.of('URI');
  let changed = false;

  for (const page of pdfDocument.getPages()) {
    const annotations = page.node.Annots();
    if (!annotations) continue;

    for (let index = 0; index < annotations.size(); index++) {
      const annotation = annotations.lookup(index, PDFDict);
      const action = annotation.lookupMaybe(actionKey, PDFDict);
      if (!action) continue;

      const uri = action.lookupMaybe(uriKey, PDFString, PDFHexString);
      if (!uri) continue;

      const href = uri.decodeText();
      const relativeHrefFromFile = toRelativeHrefFromFileUrl(href, basePath);
      const relativeHrefFromServer = renderServerBaseUrl
        ? toRelativeHrefFromServerUrl(href, basePath, renderServerBaseUrl)
        : null;
      const relativeHref = relativeHrefFromFile ?? relativeHrefFromServer;

      if (!relativeHref || href === relativeHref) continue;

      action.set(uriKey, PDFString.of(relativeHref));
      changed = true;
    }
  }

  if (!changed) return;

  const rewritten = await pdfDocument.save({
    updateFieldAppearances: false,
    useObjectStreams: false
  });
  await writeFile(outputPath, rewritten);
};
