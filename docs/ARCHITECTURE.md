# Architecture

mdpdf turns Markdown into HTML with markdown-it, styles it with print CSS, and prints it to PDF
with headless Chrome over the DevTools protocol. Everything else exists to make that fast and
faithful to GitHub and Obsidian.

```
                 ┌───────────── src/cli.ts (entry) ──────────────┐
                 │ launches Chrome right away, then loads run.ts │
                 └──────────────┬────────────────────────────────┘
                                │
 markdown file ─► front matter ─► markdown-it parse ─► prepare ─► render ─► HTML document
 (+ embeds)       options merge    (sync)              (async:     (sync)    (theme CSS,
                                                        embeds,              fonts, KaTeX,
                                                        grammars,            Mermaid)
                                                        KaTeX)                  │
                                                                                ▼
                         PDF ◄── metadata ◄── TOC page numbers ◄── Page.printToPDF ◄── Chrome
                                 (incremental   (2nd print pass,                       page loads
                                  update)        if needed)                            temp file
```

## Modules

| Path | Role |
| --- | --- |
| `src/cli.ts` | Entry point. Starts the browser before importing anything heavy, then runs `run.ts`. |
| `src/run.ts` | Argument parsing, input expansion (files, folders, globs, stdin), output planning, watch mode, reporting. |
| `src/config.ts` | Config file discovery/loading, Markdown file listing, `UsageError`. |
| `src/options.ts` | `ConvertOptions`, defaults (incl. locale-based paper size), validation, merging. |
| `src/convert.ts` | `Converter`: owns the browser and a page pool; `renderHtml()` and `convert()`. |
| `src/document.ts` | Builds the HTML document: theme CSS, fonts, `@page` rules, headers/footers, readiness script; preview CSS. |
| `src/markdown/index.ts` | markdown-it setup, the parse → prepare → render pipeline, embed resolution, source-line annotation. |
| `src/markdown/render-rules.ts` | Renderer overrides: heading ids, links/images (asset resolution), fences (Shiki, Mermaid, math), wikilinks, embeds, raw HTML rewriting. |
| `src/markdown/plugins/*` | Syntax plugins: Obsidian (wikilinks, embeds, comments, tags, block ids), callouts/alerts, math, task lists/TOC markers/page breaks, emoji. |
| `src/markdown/highlight.ts` | Lazy Shiki (Oniguruma engine); only grammars a document uses are loaded. |
| `src/markdown/math.ts` | Lazy KaTeX (+ mhchem when `\ce`/`\pu` appear). |
| `src/markdown/frontmatter.ts`, `toc.ts`, `icons.ts` | Front matter split/parse, TOC markup, callout icons (generated from Lucide by `scripts/gen-icons.ts`). |
| `src/mermaid-cache.ts` | Disk cache of rendered Mermaid SVGs, inlined into later documents. |
| `src/vault.ts` | Obsidian vault detection, name-based link resolution, settings (`strictLineBreaks`). |
| `src/pdf/cdp.ts` | Minimal DevTools protocol client over `--remote-debugging-pipe`. |
| `src/pdf/browser.ts` | Launch Chrome, pages, load-and-wait, print (streamed). |
| `src/pdf/chrome.ts` | Finds Chrome/Chromium/Edge on each platform. |
| `src/pdf/postprocess.ts` | Reads the PDF (xref, pages, named destinations) and appends metadata as an incremental update. |
| `src/server/server.ts` | `mdpdf serve`: HTTP API, asset serving, file watching (SSE), UI bundling. |
| `src/server/ui/*` | Web UI: `app.ts` (state, files, controls), `editor.ts` (CodeMirror 6), `preview.ts` (iframe updates, scroll sync). |
| `themes/*.css` | `base.css` (structure, print behaviour, CSS variables), `default.css`, `serif.css`. |
| `scripts/build.ts` | esbuild bundle of the CLI/server and the web UI into `dist/`. |

## The rendering pipeline

**Parse (sync).** One shared markdown-it instance. Linkify is only switched on for a parse when
the text contains something link-like (`www.`, `://` or `@`), because linkify-it's first use costs
~15 ms. A core rule reverts bare-domain autolinks so that, as on GitHub, only scheme, `www.` and
email links are linked.

**Prepare (async).** `collect()` walks the tokens and gathers what rendering needs: embedded notes
(read, parsed and collected recursively, with cycle detection and a depth limit), code languages
(Shiki grammars loaded in parallel) and whether KaTeX/mhchem is needed. After this step everything
is in memory, so rendering stays synchronous, which is what markdown-it's renderer requires.

**Render (sync).** Heading ids are assigned at render time with one slugger per output document, so
ids stay unique across embeds and merged files. All local URLs (images, raw HTML `src`, links to
non-Markdown files) go through an `AssetResolver`: `file://` URLs for printing, `/fs/...` for the web
UI, relative paths and CDN URLs for HTML export.

**Document.** `buildHtml()` inlines the theme CSS and `@font-face` rules, adds `@page` rules
(paper, margins, margin boxes for headers and footers), links KaTeX CSS and Mermaid only when the
document uses them, and adds a readiness script. That script resolves `window.__mdpdfReady` once
images have settled, Mermaid diagrams have rendered (each validated first, so a broken diagram
shows its source instead of an error graphic) and fonts are ready, and it reports warnings back.

Every document carries a Content-Security-Policy that lets only mdpdf's own scripts run (they carry
a per-process nonce), so scripts in raw HTML stay inert when printing and in the web preview.

**Print.** The HTML is written to a temporary file and loaded via `file://`. A `<base>` element
can't be used because it would break `#fragment` links. `Page.printToPDF` uses
`preferCSSPageSize`, `generateTaggedPDF` and `generateDocumentOutline` (bookmarks from headings),
and streams the result.

**TOC page numbers.** Chrome writes named destinations for every linked id. After the first print,
`destinationPages()` maps each heading to a page. The numbers are filled into the TOC in the live
page, which is printed again. The second pass costs only the print itself (~15–100 ms), because the
page is already laid out.

**Metadata.** Chrome only sets the title. `setMetadata()` appends an incremental update with the
title, author, subject, keywords, creator and `DisplayDocTitle`, leaving the original bytes
untouched.

## Performance design

- Chrome launches first, before the rest of the program is loaded. The first page target is
  requested while Chrome is still booting, and Markdown rendering runs in parallel.
- One browser and a pool of pages per run (`-j` concurrent documents, default 4).
- Lazy loading everywhere: Shiki only if code needs highlighting, and only those grammars; KaTeX
  only for math; mhchem only for `\ce`; Mermaid (5 MB) only in documents with diagrams; YAML only
  with front matter.
- Rendered Mermaid diagrams are cached on disk. When every diagram of a document is cached, the
  page is built without Mermaid; new renderings are collected from the page after it loads.
- Static font files instead of variable fonts. Skia embeds variable fonts as Type 3, which is
  larger, renders worse and can't be searched.
- The bundled build (`dist/`) avoids TypeScript stripping and most module resolution. That saves
  ~45 ms of start-up.

## Web UI

`mdpdf serve` is a plain `node:http` server:

- `GET /api/files`, `GET|PUT /api/file?path=` for listing, reading and saving Markdown files inside
  the served folder.
- `POST /api/render` returns the preview HTML with `data-line` attributes (source lines of top-level
  blocks) for scroll sync, plus effective options and warnings.
- `POST /api/pdf` returns the real PDF from the same `Converter`.
- `GET /api/events` is a Server-Sent Events stream of file changes.
- `GET /fs/<absolute path>` serves files the renderer referenced, files under the folder, and
  siblings of referenced stylesheets. Only asset types are served.

Security: binds to 127.0.0.1, rejects foreign `Host` headers (DNS rebinding), and requires an
`X-Mdpdf` header plus a same-origin `Origin` on writes (cross-site pages can't send it without a
preflight, which is never granted). Paths are confined to the served folder.

The preview iframe is replaced only when the document "shell" (styles, scripts) changes. Otherwise
the article's HTML is swapped in place, which keeps scroll position, loaded images and rendered
Mermaid SVGs (cached by diagram source). The page is scaled to fit the pane when that keeps it
legible (≥ 80%); below that it reflows.
