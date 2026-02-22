import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { escapeHtml } from '../utils/html.js';
import { toErrorMessage } from '../utils/errors.js';

export interface HtmlTemplateInput {
  templatePath?: string | null;
  title: string;
  css: string;
  content: string;
  basePath?: string;
  baseHref?: string;
  includeMathJax: boolean;
  includeMermaid: boolean;
  mathJaxSrc?: string;
  mermaidSrc?: string;
  mathJaxBaseUrl?: string;
  mathJaxFontBaseUrl?: string;
}

const DEFAULT_TEMPLATE = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    {{base}}
    <title>{{title}}</title>
    <style>{{css}}</style>
    {{mathjax}}
    {{mermaid}}
  </head>
  <body class="markdown-body">
    {{content}}
  </body>
</html>`;
const templateCache = new Map<string, Promise<string>>();

const serializeInlineScriptObject = (value: Record<string, unknown>): string =>
  JSON.stringify(value, null, 2).replace(/</g, '\\u003c');

const buildMathJaxSnippet = (input: HtmlTemplateInput): string => {
  const mathJaxSrc = input.mathJaxSrc ?? 'https://cdn.jsdelivr.net/npm/mathjax@4/tex-chtml.js';
  const config: Record<string, unknown> = {
    options: {
      ignoreHtmlClass: 'convpdf-math-ignore'
    },
    tex: {
      inlineMath: [
        ['$', '$'],
        ['\\(', '\\)']
      ],
      displayMath: [
        ['$$', '$$'],
        ['\\[', '\\]']
      ]
    },
    svg: { fontCache: 'global' }
  };

  if (input.mathJaxBaseUrl) {
    config.loader = {
      paths: {
        mathjax: input.mathJaxBaseUrl,
        ...(input.mathJaxFontBaseUrl ? { 'mathjax-newcm': input.mathJaxFontBaseUrl } : {})
      }
    };
  }
  if (input.mathJaxFontBaseUrl) {
    config.chtml = {
      fontURL: `${input.mathJaxFontBaseUrl}/chtml/woff2`
    };
  }

  return `
<script>
  window.MathJax = ${serializeInlineScriptObject(config)};
</script>
<script id="MathJax-script" defer src="${escapeHtml(mathJaxSrc)}"></script>`;
};

const buildMermaidSnippet = (input: HtmlTemplateInput): string => {
  const mermaidSrc =
    input.mermaidSrc ?? 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
  return `
<script id="Mermaid-script" src="${escapeHtml(mermaidSrc)}"></script>
<script>
  if (window.mermaid && typeof window.mermaid.initialize === 'function') {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  }
</script>`;
};

const loadTemplate = async (templatePath?: string | null): Promise<string> => {
  if (!templatePath) return DEFAULT_TEMPLATE;
  const resolvedTemplatePath = resolve(templatePath);
  const cached = templateCache.get(resolvedTemplatePath);
  if (cached) return cached;

  const loadPromise = (async () => {
    try {
      return await readFile(resolvedTemplatePath, 'utf-8');
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      throw new Error(`Failed to read template at "${templatePath}": ${message}`);
    }
  })();
  templateCache.set(resolvedTemplatePath, loadPromise);
  try {
    return await loadPromise;
  } catch (error: unknown) {
    templateCache.delete(resolvedTemplatePath);
    throw error;
  }
};

const TEMPLATE_TOKEN_PATTERN = /\{\{(title|base|css|content|mathjax|mermaid)\}\}/g;

export const renderTemplate = async (input: HtmlTemplateInput): Promise<string> => {
  const template = await loadTemplate(input.templatePath);
  const baseTag = input.baseHref
    ? `<base href="${escapeHtml(input.baseHref)}">`
    : input.basePath
      ? `<base href="${escapeHtml(pathToFileURL(resolve(input.basePath)).href)}/">`
      : '';

  const replacements: Record<string, string> = {
    title: escapeHtml(input.title),
    base: baseTag,
    css: input.css,
    content: input.content,
    mathjax: input.includeMathJax ? buildMathJaxSnippet(input) : '',
    mermaid: input.includeMermaid ? buildMermaidSnippet(input) : ''
  };

  return template.replace(TEMPLATE_TOKEN_PATTERN, (_, token: string) => replacements[token] ?? '');
};
