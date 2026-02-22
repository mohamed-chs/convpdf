import { pathToFileURL } from 'url';
import type { AssetMode } from '../types.js';
import { getRuntimeAssetPaths, isRuntimeInstalled, resolveAssetCacheDir } from './manager.js';

export const CDN_MATHJAX_SRC = 'https://cdn.jsdelivr.net/npm/mathjax@4/tex-chtml.js';
export const CDN_MERMAID_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
export const RUNTIME_ASSET_ROUTES = {
  mathJaxBase: '/__convpdf_assets/mathjax',
  mathJaxFontBase: '/__convpdf_assets/mathjax-newcm-font',
  mermaidPath: '/__convpdf_assets/mermaid/mermaid.min.js'
} as const;

export interface AssetResolutionInput {
  mode?: AssetMode;
  cacheDir?: string;
  allowNetworkFallback?: boolean;
  serverBaseUrl?: string;
}

export interface RuntimeAssetResolution {
  mathJaxSrc: string;
  mermaidSrc: string;
  mathJaxBaseUrl?: string;
  mathJaxFontBaseUrl?: string;
  warning?: string;
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');
const runtimeInstalledCache = new Map<string, Promise<boolean>>();
const runtimeAssetResolutionCache = new Map<string, Promise<RuntimeAssetResolution>>();

const resolveInstalledCached = (cacheDir?: string): Promise<boolean> => {
  const cacheKey = resolveAssetCacheDir(cacheDir);
  const cached = runtimeInstalledCache.get(cacheKey);
  if (cached) return cached;

  const checkPromise = isRuntimeInstalled(cacheDir)
    .then((installed) => {
      // Cache only positive checks so newly-installed assets are picked up without
      // requiring a process restart.
      if (!installed) {
        runtimeInstalledCache.delete(cacheKey);
      }
      return installed;
    })
    .catch((error: unknown) => {
      runtimeInstalledCache.delete(cacheKey);
      throw error;
    });
  runtimeInstalledCache.set(cacheKey, checkPromise);
  return checkPromise;
};

const toServerRuntimeUrls = (
  serverBaseUrl: string
): {
  mathJaxSrc: string;
  mermaidSrc: string;
  mathJaxBaseUrl: string;
  mathJaxFontBaseUrl: string;
} => {
  const base = trimTrailingSlash(serverBaseUrl);
  return {
    mathJaxSrc: `${base}${RUNTIME_ASSET_ROUTES.mathJaxBase}/tex-chtml.js`,
    mermaidSrc: `${base}${RUNTIME_ASSET_ROUTES.mermaidPath}`,
    mathJaxBaseUrl: `${base}${RUNTIME_ASSET_ROUTES.mathJaxBase}`,
    mathJaxFontBaseUrl: `${base}${RUNTIME_ASSET_ROUTES.mathJaxFontBase}`
  };
};

export const resolveRuntimeAssetSources = async (
  input: AssetResolutionInput
): Promise<RuntimeAssetResolution> => {
  const mode = input.mode ?? 'auto';
  const allowNetworkFallback = input.allowNetworkFallback ?? true;
  const cacheRoot = resolveAssetCacheDir(input.cacheDir);
  const normalizedServerBaseUrl = input.serverBaseUrl ? trimTrailingSlash(input.serverBaseUrl) : '';
  const cacheKey = `${mode}|${allowNetworkFallback ? '1' : '0'}|${cacheRoot}|${normalizedServerBaseUrl}`;
  const cached = runtimeAssetResolutionCache.get(cacheKey);
  if (cached) return cached;

  const cachedPromise = (async (): Promise<RuntimeAssetResolution> => {
    if (mode === 'cdn') {
      return {
        mathJaxSrc: CDN_MATHJAX_SRC,
        mermaidSrc: CDN_MERMAID_SRC
      };
    }

    const installed = await resolveInstalledCached(input.cacheDir);
    if (installed) {
      const paths = getRuntimeAssetPaths(input.cacheDir);
      if (input.serverBaseUrl) {
        const urls = toServerRuntimeUrls(input.serverBaseUrl);
        return urls;
      }

      const mathJaxSrc = pathToFileURL(paths.mathJaxPath).href;
      const mermaidSrc = pathToFileURL(paths.mermaidPath).href;
      return {
        mathJaxSrc,
        mermaidSrc,
        mathJaxBaseUrl: mathJaxSrc.replace(/\/tex-chtml\.js$/, ''),
        mathJaxFontBaseUrl: trimTrailingSlash(pathToFileURL(paths.mathJaxFontDir).href)
      };
    }

    if (!allowNetworkFallback) {
      throw new Error(
        `Local runtime assets are required but missing. Run: convpdf assets install --cache-dir "${cacheRoot}"`
      );
    }

    const warning =
      mode === 'local'
        ? 'Local runtime assets were not found. Falling back to CDN assets.'
        : undefined;

    const fallbackResolution = {
      mathJaxSrc: CDN_MATHJAX_SRC,
      mermaidSrc: CDN_MERMAID_SRC,
      warning: allowNetworkFallback ? warning : undefined
    };
    // Missing-local fallback is not cached so installs in the same process
    // immediately switch to local assets.
    runtimeAssetResolutionCache.delete(cacheKey);
    return fallbackResolution;
  })();
  runtimeAssetResolutionCache.set(cacheKey, cachedPromise);
  try {
    return await cachedPromise;
  } catch (error: unknown) {
    runtimeAssetResolutionCache.delete(cacheKey);
    throw error;
  }
};
