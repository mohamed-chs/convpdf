import type { RendererOptions } from '../types.js';
import { resolveRuntimeAssetSources } from './resolve.js';

export interface RuntimeAssetUsage {
  math: boolean;
  mermaid: boolean;
}

export interface RuntimeAssetPolicyOptions {
  assetMode: NonNullable<RendererOptions['assetMode']>;
  assetCacheDir?: string;
  allowNetworkFallback: NonNullable<RendererOptions['allowNetworkFallback']>;
  mathJaxSrc?: string;
  mermaidSrc?: string;
  mathJaxBaseUrl?: string;
  mathJaxFontBaseUrl?: string;
}

export interface RuntimeAssetPlan {
  mathJaxSrc?: string;
  mermaidSrc?: string;
  mathJaxBaseUrl?: string;
  mathJaxFontBaseUrl?: string;
  warning?: string;
}

export const resolveDocumentRuntimeAssets = async (
  opts: RuntimeAssetPolicyOptions,
  usage: RuntimeAssetUsage,
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
