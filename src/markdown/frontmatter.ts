import yaml from 'js-yaml';
import type { Frontmatter, FrontmatterParseResult } from '../types.js';
import { toErrorMessage } from '../utils/errors.js';

const normalizeFrontmatter = (value: unknown): Frontmatter => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Frontmatter;
};

export const parseFrontmatter = (markdown: string): FrontmatterParseResult => {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { data: {}, content: markdown, warnings: [] };
  }

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.trim() === '---') {
      closingIndex = index;
      break;
    }
  }

  if (closingIndex < 0) {
    return { data: {}, content: markdown, warnings: [] };
  }

  const source = lines.slice(1, closingIndex).join('\n');
  const content = lines.slice(closingIndex + 1).join('\n');
  if (!source.trim()) {
    return {
      data: {},
      content,
      warnings: []
    };
  }

  try {
    const parsed = yaml.load(source, { schema: yaml.JSON_SCHEMA });
    return {
      data: normalizeFrontmatter(parsed),
      content,
      warnings: []
    };
  } catch (error: unknown) {
    const message = toErrorMessage(error);
    return {
      data: {},
      content: markdown,
      warnings: [`Frontmatter parsing failed: ${message}`]
    };
  }
};
