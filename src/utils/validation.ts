import type { PDFMargin } from 'puppeteer';
import { PAPER_FORMATS, type PaperFormat } from '../types.js';

const VALID_MARGIN = /^(?:0(?:\.0+)?|\d*\.?\d+(px|in|cm|mm|pc|pt))$/i;
const FORMAT_LOOKUP: ReadonlyMap<string, PaperFormat> = new Map(
  PAPER_FORMATS.map((value) => [value.toLowerCase(), value])
);
export const MAX_CONCURRENT_PAGES = 128;
export const DEFAULT_MARGIN = '15mm 10mm';
export const DEFAULT_PAPER_FORMAT: PaperFormat = 'A4';
export const DEFAULT_TOC_DEPTH = 6;

export const parseMargin = (rawMargin?: string | number): PDFMargin => {
  const marginValue =
    typeof rawMargin === 'string'
      ? rawMargin
      : typeof rawMargin === 'number'
        ? String(rawMargin)
        : '';
  const margin = marginValue.trim() || DEFAULT_MARGIN;
  const parts = margin.split(/\s+/).filter(Boolean);

  if (parts.length < 1 || parts.length > 4) {
    throw new Error(
      `Invalid margin value "${rawMargin}". Use 1 to 4 CSS length values, e.g. "20mm" or "10mm 12mm".`
    );
  }
  for (const part of parts) {
    if (!VALID_MARGIN.test(part)) {
      throw new Error(
        `Invalid margin token "${part}". Expected 0 or a non-zero value with a CSS length unit (mm, cm, in, px, pt, pc).`
      );
    }
  }

  if (parts.length === 1) {
    const [all] = parts;
    return { top: all, right: all, bottom: all, left: all };
  }

  if (parts.length === 2) {
    const [vertical, horizontal] = parts;
    return { top: vertical, right: horizontal, bottom: vertical, left: horizontal };
  }

  if (parts.length === 3) {
    const [top, horizontal, bottom] = parts;
    return { top, right: horizontal, bottom, left: horizontal };
  }

  const [top, right, bottom, left] = parts;
  return { top, right, bottom, left };
};

export const normalizePaperFormat = (input?: string): PaperFormat => {
  const value = input?.trim() || DEFAULT_PAPER_FORMAT;
  const normalized = FORMAT_LOOKUP.get(value.toLowerCase());
  if (!normalized) {
    throw new Error(
      `Invalid paper format "${value}". Allowed formats: ${PAPER_FORMATS.join(', ')}.`
    );
  }
  return normalized;
};

export const normalizeTocDepth = (input?: number): number => {
  if (input === undefined) return DEFAULT_TOC_DEPTH;
  if (!Number.isInteger(input)) {
    throw new Error(`Invalid TOC depth "${String(input)}". Expected an integer from 1 to 6.`);
  }
  if (input < 1 || input > 6) {
    throw new Error(`Invalid TOC depth "${input}". Expected a value between 1 and 6.`);
  }
  return input;
};

export const normalizeMaxConcurrentPages = (value: number): number => {
  if (!Number.isInteger(value)) {
    throw new Error(
      `Invalid max pages value "${String(value)}". Expected an integer between 1 and ${MAX_CONCURRENT_PAGES}.`
    );
  }
  if (value < 1 || value > MAX_CONCURRENT_PAGES) {
    throw new Error(
      `Invalid max pages value "${String(value)}". Expected an integer between 1 and ${MAX_CONCURRENT_PAGES}.`
    );
  }
  return value;
};
