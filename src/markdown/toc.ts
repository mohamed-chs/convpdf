import { Marked } from 'marked';
import type { CustomToken, TocHeading } from '../types.js';
import { escapeHtml } from '../utils/html.js';
import { normalizeTocDepth } from '../utils/validation.js';

const stripNestedAnchors = (value: string): string =>
  value.replace(/<a\s+[^>]*>([\s\S]*?)<\/a>/gi, '$1');

const inlineParser = new Marked();

interface TocNode {
  heading: TocHeading;
  children: TocNode[];
}

const renderTocNodes = (nodes: TocNode[]): string => {
  if (!nodes.length) return '';
  const items = nodes
    .map((node) => {
      const children = renderTocNodes(node.children);
      return `<li class="toc-level-${node.heading.level}"><a href="#${escapeHtml(node.heading.id)}">${stripNestedAnchors(node.heading.text)}</a>${children}</li>`;
    })
    .join('\n');
  return `<ul>${items}</ul>`;
};

export const generateToc = (tokens: CustomToken[], depthInput?: number): string => {
  const depth = normalizeTocDepth(depthInput);
  const headings: TocHeading[] = [];

  const walk = (items: CustomToken[]): void => {
    for (const token of items) {
      if (token.type === 'heading' && token.depth !== undefined && token.depth <= depth) {
        headings.push({
          level: token.depth,
          text: inlineParser.parseInline(token.text ?? '') as string,
          id: token.id ?? ''
        });
      }

      if (token.tokens?.length) walk(token.tokens);
    }
  };

  walk(tokens);
  if (!headings.length) return '';

  const root: TocNode = {
    heading: { level: 0, text: '', id: '' },
    children: []
  };
  const stack: TocNode[] = [root];

  for (const heading of headings) {
    const node: TocNode = { heading, children: [] };
    while (
      stack.length > 1 &&
      (stack[stack.length - 1]?.heading.level ?? Number.POSITIVE_INFINITY) >= heading.level
    ) {
      stack.pop();
    }
    const parent = stack[stack.length - 1] ?? root;
    parent.children.push(node);
    stack.push(node);
  }

  return `<div class="toc"><h2>Table of Contents</h2>${renderTocNodes(root.children)}</div>`;
};
