import type { Token } from 'marked';
import { readFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import GithubSlugger from 'github-slugger';
import type { CustomToken, RendererOptions } from '../types.js';
import { parseFrontmatter } from '../markdown/frontmatter.js';
import { createMarkedInstance } from '../markdown/marked.js';
import { hasMathSyntax, protectMath } from '../markdown/math.js';
import { hasMermaidSyntax } from '../markdown/mermaid.js';
import { generateToc } from '../markdown/toc.js';
import { renderTemplate } from '../html/template.js';
import { resolveRuntimeAssetSources } from '../assets/resolve.js';
import { normalizeTocDepth } from '../utils/validation.js';
import { toErrorMessage } from '../utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (pathValue: string) => readFile(join(__dirname, pathValue), 'utf-8');
const stylesPromise = Promise.all([read('../styles/default.css'), read('../styles/github.css')]);

export interface DocumentCompileOptions extends RendererOptions {
  margin: string;
  format: NonNullable<RendererOptions['format']>;
  assetMode: NonNullable<RendererOptions['assetMode']>;
  allowNetworkFallback: NonNullable<RendererOptions['allowNetworkFallback']>;
  maxConcurrentPages: NonNullable<RendererOptions['maxConcurrentPages']>;
  linkTargetFormat: NonNullable<RendererOptions['linkTargetFormat']>;
}

interface RuntimeAssetPlan {
  mathJaxSrc?: string;
  mermaidSrc?: string;
  mathJaxBaseUrl?: string;
  mathJaxFontBaseUrl?: string;
  warning?: string;
}

const resolveRuntimeAssetPlan = async (
  opts: DocumentCompileOptions,
  usage: { math: boolean; mermaid: boolean },
  serverBaseUrl?: string
): Promise<RuntimeAssetPlan> => {
  if (!usage.math && !usage.mermaid) {
    return {};
  }

  const needsMathAssetResolution = usage.math && !opts.mathJaxSrc;
  const needsMermaidAssetResolution = usage.mermaid && !opts.mermaidSrc;
  if (!needsMathAssetResolution && !needsMermaidAssetResolution) {
    return {
      mathJaxSrc: opts.mathJaxSrc,
      mermaidSrc: opts.mermaidSrc,
      mathJaxBaseUrl: opts.mathJaxBaseUrl,
      mathJaxFontBaseUrl: opts.mathJaxFontBaseUrl
    };
  }

  const resolved = await resolveRuntimeAssetSources({
    mode: opts.assetMode,
    cacheDir: opts.assetCacheDir,
    allowNetworkFallback: opts.allowNetworkFallback,
    serverBaseUrl
  });

  return {
    mathJaxSrc: opts.mathJaxSrc ?? resolved.mathJaxSrc,
    mermaidSrc: opts.mermaidSrc ?? resolved.mermaidSrc,
    mathJaxBaseUrl: opts.mathJaxBaseUrl ?? resolved.mathJaxBaseUrl,
    mathJaxFontBaseUrl: opts.mathJaxFontBaseUrl ?? resolved.mathJaxFontBaseUrl,
    warning: resolved.warning
  };
};

const reorderFootnotesToEnd = (tokens: CustomToken[]): void => {
  const footnoteIndex = tokens.findIndex((token) => token.type === 'footnotes');
  if (footnoteIndex < 0) return;
  const [footnotes] = tokens.splice(footnoteIndex, 1);
  if (footnotes) tokens.push(footnotes);
};

const restoreMathInHeadingTokens = (
  tokens: CustomToken[],
  restoreMath: (value: string) => string
): void => {
  for (const token of tokens) {
    if (token.type === 'heading' && typeof token.text === 'string') {
      token.text = restoreMath(token.text);
    }
    if (token.tokens?.length) {
      restoreMathInHeadingTokens(token.tokens, restoreMath);
    }
  }
};

export class DocumentCompiler {
  private readonly cssCache = new Map<string, Promise<string>>();

  private async readCustomCss(pathValue?: string | null): Promise<string> {
    if (!pathValue) return '';
    const absolutePath = resolve(pathValue);
    const cached = this.cssCache.get(absolutePath);
    if (cached) return cached;

    const readPromise = (async () => {
      try {
        return await readFile(absolutePath, 'utf-8');
      } catch (error: unknown) {
        const message = toErrorMessage(error);
        throw new Error(`Failed to read custom CSS at "${pathValue}": ${message}`, {
          cause: error
        });
      }
    })();

    this.cssCache.set(absolutePath, readPromise);
    try {
      return await readPromise;
    } catch (error: unknown) {
      this.cssCache.delete(absolutePath);
      throw error;
    }
  }

  async compile(
    markdown: string,
    opts: DocumentCompileOptions,
    runtimeAssetsOverride?: RuntimeAssetPlan,
    runtimeServerBaseUrl?: string
  ): Promise<string> {
    const parsedFrontmatter = parseFrontmatter(markdown);
    const { data, content } = parsedFrontmatter;
    for (const warning of parsedFrontmatter.warnings) {
      console.warn(warning);
    }

    const runtimeUsage = { math: hasMathSyntax(content), mermaid: hasMermaidSyntax(content) };
    const runtimeAssets =
      runtimeAssetsOverride ??
      (await resolveRuntimeAssetPlan(opts, runtimeUsage, runtimeServerBaseUrl));
    if (runtimeAssets.warning) {
      console.warn(runtimeAssets.warning);
    }

    const slugger = new GithubSlugger();
    const marked = createMarkedInstance(slugger, opts.linkTargetFormat);
    const {
      text: safeContent,
      restore: restoreMath,
      restoreHtml: restoreMathHtml
    } = protectMath(content);
    const tokens = marked.lexer(safeContent) as unknown as CustomToken[];

    restoreMathInHeadingTokens(tokens, restoreMath);
    if (marked.defaults.walkTokens) {
      void marked.walkTokens(tokens as unknown as Token[], marked.defaults.walkTokens);
    }

    reorderFootnotesToEnd(tokens);

    const tocDepth = normalizeTocDepth(
      typeof data.tocDepth === 'number' ? data.tocDepth : opts.tocDepth
    );
    const hasTocPlaceholder = tokens.some((token) => token.type === 'tocPlaceholder');
    const frontmatterToc = typeof data.toc === 'boolean' ? data.toc : undefined;
    const tocEnabled = opts.toc ?? frontmatterToc ?? false;
    const tocHtml = tocEnabled || hasTocPlaceholder ? generateToc(tokens, tocDepth) : '';

    let html = restoreMathHtml(marked.parser(tokens as unknown as Token[]));
    if (tocHtml) {
      if (html.includes('[[TOC_PLACEHOLDER]]')) {
        html = html.split('[[TOC_PLACEHOLDER]]').join(tocHtml);
      } else if (tocEnabled && !hasTocPlaceholder) {
        html = tocHtml + html;
      }
    }

    const customCssContent = await this.readCustomCss(opts.customCss);
    const [defaultCss, highlightCss] = await stylesPromise;
    const css = `${defaultCss}\n${highlightCss}\n${customCssContent}`;
    const title =
      typeof opts.title === 'string'
        ? opts.title
        : typeof data.title === 'string'
          ? data.title
          : 'Markdown Document';

    return renderTemplate({
      templatePath: opts.template,
      title,
      css,
      content: html,
      basePath: opts.basePath,
      baseHref: opts.baseHref,
      includeMathJax: runtimeUsage.math,
      includeMermaid: runtimeUsage.mermaid,
      mathJaxSrc: runtimeAssets.mathJaxSrc,
      mermaidSrc: runtimeAssets.mermaidSrc,
      mathJaxBaseUrl: runtimeAssets.mathJaxBaseUrl,
      mathJaxFontBaseUrl: runtimeAssets.mathJaxFontBaseUrl
    });
  }
}
