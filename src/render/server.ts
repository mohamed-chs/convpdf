import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import { extname, resolve } from 'path';
import { getRuntimeAssetPaths } from '../assets/manager.js';
import { RUNTIME_ASSET_ROUTES } from '../assets/resolve.js';

export const SOURCE_ROUTE_PREFIX = '/__convpdf_source/';
const DOCUMENT_ROUTE_PREFIX = '/document/';
const DOCUMENT_ROUTE_PATTERN = new RegExp(`^${DOCUMENT_ROUTE_PREFIX}([a-f0-9]+)\\.html$`, 'i');

interface RenderDocumentHandle {
  url: string;
  sourceBaseUrl?: string;
  setHtml: (html: string) => void;
  dispose: () => void;
}

export interface RenderHttpServer {
  baseUrl: string;
  registerDocument: (sourceBasePath?: string) => RenderDocumentHandle;
  close: () => Promise<void>;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};

const RUNTIME_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const sendError = (res: ServerResponse, code: number): void => {
  res.statusCode = code;
  res.end(code === 404 ? 'Not Found' : 'Internal Server Error');
};

const serveFile = async (
  res: ServerResponse,
  absolutePath: string,
  options?: { cacheControl?: string; memoryCache?: Map<string, Buffer> }
): Promise<void> => {
  try {
    const cachedBuffer = options?.memoryCache?.get(absolutePath);
    const buffer = cachedBuffer ?? (await readFile(absolutePath));
    if (!cachedBuffer && options?.memoryCache) {
      options.memoryCache.set(absolutePath, buffer);
    }
    res.statusCode = 200;
    res.setHeader(
      'Content-Type',
      MIME_TYPES[extname(absolutePath).toLowerCase()] ?? 'application/octet-stream'
    );
    if (options?.cacheControl) {
      res.setHeader('Cache-Control', options.cacheControl);
    }
    res.end(buffer);
  } catch {
    sendError(res, 404);
  }
};

const resolveUnder = (basePath: string, relativePathValue: string): string | null => {
  const candidate = resolve(basePath, relativePathValue);
  const normalizedBase = resolve(basePath);
  if (
    candidate === normalizedBase ||
    candidate.startsWith(`${normalizedBase}${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    return candidate;
  }
  return null;
};

export const createRenderServer = async (options: {
  assetCacheDir?: string;
}): Promise<RenderHttpServer> => {
  const runtimePaths = getRuntimeAssetPaths(options.assetCacheDir);
  const documents = new Map<string, { html: string; sourceBasePath?: string }>();
  const runtimeAssetCache = new Map<string, Buffer>();
  let nextDocumentId = 1;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(requestUrl.pathname);

    const documentMatch = DOCUMENT_ROUTE_PATTERN.exec(pathname);
    if (documentMatch) {
      const documentId = documentMatch[1] ?? '';
      const document = documents.get(documentId);
      if (!document) {
        sendError(res, 404);
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(document.html);
      return;
    }

    if (pathname.startsWith(SOURCE_ROUTE_PREFIX)) {
      const sourcePath = pathname.slice(SOURCE_ROUTE_PREFIX.length);
      const separatorIndex = sourcePath.indexOf('/');
      if (separatorIndex < 0) {
        sendError(res, 404);
        return;
      }
      const documentId = sourcePath.slice(0, separatorIndex);
      const relPath = sourcePath.slice(separatorIndex + 1);
      const document = documents.get(documentId);
      if (!document?.sourceBasePath) {
        sendError(res, 404);
        return;
      }
      const absolute = resolveUnder(document.sourceBasePath, relPath);
      if (!absolute) {
        sendError(res, 404);
        return;
      }
      await serveFile(res, absolute);
      return;
    }

    if (pathname.startsWith(`${RUNTIME_ASSET_ROUTES.mathJaxBase}/`)) {
      const relPath = pathname.slice(`${RUNTIME_ASSET_ROUTES.mathJaxBase}/`.length);
      const absolute = resolveUnder(runtimePaths.mathJaxDir, relPath);
      if (!absolute) {
        sendError(res, 404);
        return;
      }
      await serveFile(res, absolute, {
        cacheControl: RUNTIME_CACHE_CONTROL,
        memoryCache: runtimeAssetCache
      });
      return;
    }

    if (pathname.startsWith(`${RUNTIME_ASSET_ROUTES.mathJaxFontBase}/`)) {
      const relPath = pathname.slice(`${RUNTIME_ASSET_ROUTES.mathJaxFontBase}/`.length);
      const absolute = resolveUnder(runtimePaths.mathJaxFontDir, relPath);
      if (!absolute) {
        sendError(res, 404);
        return;
      }
      await serveFile(res, absolute, {
        cacheControl: RUNTIME_CACHE_CONTROL,
        memoryCache: runtimeAssetCache
      });
      return;
    }

    if (pathname === RUNTIME_ASSET_ROUTES.mermaidPath) {
      await serveFile(res, runtimePaths.mermaidPath, {
        cacheControl: RUNTIME_CACHE_CONTROL,
        memoryCache: runtimeAssetCache
      });
      return;
    }

    sendError(res, 404);
  };

  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      sendError(res, 500);
    });
  });

  await new Promise<void>((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectStart);
      resolveStart();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolveClose) => {
      server.close(() => {
        resolveClose();
      });
    });
    throw new Error('Failed to start render server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    registerDocument: (sourceBasePath?: string) => {
      const id = String(nextDocumentId);
      nextDocumentId += 1;
      documents.set(id, { html: '', sourceBasePath });
      return {
        url: `http://127.0.0.1:${address.port}${DOCUMENT_ROUTE_PREFIX}${id}.html`,
        sourceBaseUrl: sourceBasePath
          ? `http://127.0.0.1:${address.port}${SOURCE_ROUTE_PREFIX}${id}/`
          : undefined,
        setHtml: (html: string) => {
          const existing = documents.get(id);
          if (existing) {
            existing.html = html;
          }
        },
        dispose: () => {
          documents.delete(id);
        }
      };
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      })
  };
};
