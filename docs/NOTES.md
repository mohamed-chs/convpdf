# Development notes

Decisions, measurements and gotchas, roughly in the order they came up. Numbers are from a 16-core
Linux machine with Chrome 157 and Node 26.

## Choices

- **Own DevTools client instead of Puppeteer.** We only need launch, a page, navigate, evaluate
  and print. A pipe-based client (`--remote-debugging-pipe`, NUL-delimited JSON on fds 3/4) is about
  130 lines, has no dependencies and starts faster. Chrome launch is ~130–150 ms.
- **The user's Chrome rather than a bundled one.** It saves a ~150 MB download. `findChrome()`
  checks env vars, Puppeteer's cache (chrome-headless-shell), standard install locations and `PATH`.
- **markdown-it.** It is CommonMark compliant, fast, synchronous and easy to extend with plugins.
  Obsidian syntax, callouts, math, task lists and emoji are our own small plugins. Footnotes,
  deflists, abbreviations and mark come from the markdown-it org.
- **Shiki (Oniguruma engine).** It gives VS Code-quality highlighting. Benchmark for a typical
  document: raw/JS/Oniguruma engines all ~180 ms cold, so we kept Oniguruma for accuracy. We render
  tokens ourselves into `<span class="line">` blocks (no newline text nodes), which makes line
  numbers and diff backgrounds pure CSS.
- **KaTeX server-side, Mermaid in the page.** KaTeX is synchronous and fast in Node. Mermaid needs a
  DOM, so it runs in the page Chrome is printing anyway.
- **CSS `@page` margin boxes for headers and footers** (Chrome 131+). Unlike Chrome's
  `headerTemplate`, they use the document's fonts and support `counter(page)` and `counter(pages)`.
- **Static Fontsource fonts.** Variable fonts are embedded by Skia as Type 3. `pdffonts` must show
  no Type 3 fonts (there is a test for this). We rewrite `font-display` to `block` and drop woff
  fallbacks.
- **Symbol fonts before CJK fonts** in the fallback stack. Otherwise ✓ and → come from a CJK font
  and are embedded as Type 3.
- **No `<base>` element.** It would make `#anchor` links resolve against the base and break
  in-document links. All local URLs are made absolute in the renderer instead.
- **Default paper size from the locale.** Letter in the US, Canada, Mexico, the Philippines and
  most of Latin America; A4 elsewhere.
- **Option precedence**: defaults < Obsidian vault settings < config file < front matter < CLI. The
  web UI's controls are a per-request layer above the CLI.

## Performance log

| Change | Effect |
| --- | --- |
| Launch Chrome concurrently with Markdown rendering | Overlaps the 130 ms launch with parsing |
| Emoji: own `:name:` rule using markdown-it-emoji's data map instead of its regex | -24 ms on first use |
| Linkify only when the text looks link-like | -15 ms for documents without URLs |
| `setTimeout(...).unref()` in `Browser.close()` race | Fixed a 1.5 s delay at exit |
| Skip Shiki entirely when no code block needs highlighting | -55 ms rendering (off the critical path) |
| Entry point launches Chrome before loading the rest of the CLI | Chrome starts at ~47 ms instead of ~85 ms (source run); -25 ms total |
| Request the first page target while Chrome boots | -15 to -30 ms |
| esbuild bundle (`dist/`) | `--version` 91 → 44 ms; single conversion 312 → 260 ms |
| Bundling dependencies too (markdown-it etc.) | Slower (defeats lazy loading); reverted |

Current numbers: a one-page document takes ~0.26 s end to end (bundled). The showcase (7 pages,
Mermaid, math, TOC) takes ~0.9 s. A folder of 30 short documents with code and math takes 0.8 s with
`-j 4` (1.5 s with `-j 1`).

Where the remaining time goes for a one-page document: Node start ~40 ms, Chrome launch ~130 ms
(critical path), page load ~30 ms, print ~15 ms.

Ideas not done yet:

- Render Mermaid in a separate warm page while Markdown is being rendered, and cache SVGs across
  watch-mode runs.
- Keep a browser alive between CLI runs (a daemon). That would cut ~150 ms but adds lifecycle
  complexity.

## Gotchas

- `IO.read`/`IO.close` for streamed PDFs must be sent on the page's session, not the browser's.
- `Page.printToPDF` with `generateDocumentOutline` requires `generateTaggedPDF`.
- Skia writes a classic xref table and a `/Dests` dictionary (not a name tree) for named
  destinations. The reader supports both.
- Mermaid's `useMaxWidth` (default true) makes diagrams fill the page width. We turn it off for
  every diagram type and cap the width with CSS instead.
- Mermaid's `default` theme looks washed out in print. The `auto` mode uses the `base` theme with
  variables matched to the mdpdf theme, including explicit pie, Gantt and git palettes.
- Invalid Mermaid renders a "bomb" error graphic. `mermaid.parse()` first, and on failure keep the
  source visible and report a warning.
- GitHub alerts and Obsidian callouts share syntax. Callout titles may contain inline Markdown.
  Fold markers (`+`/`-`) are kept as data attributes, and folded callouts print expanded.
- `<details>` is forced open (`<details open>`) so its content is printed.
- Obsidian embeds of a heading include everything until the next heading of the same or higher
  level. Footnotes referenced in that section are kept.
- markdown-it only implements `~~double~~` strikethrough; GFM also allows `~single~`. Our plugin
  uses a separate delimiter marker for single tildes so `~a~~` never pairs.
- TOC entries include headings from embedded notes. This matches what's visible in the document.
- Right-to-left text: `unicode-bidi: plaintext` on paragraphs, list items, headings and cells gives
  each block its direction from its own text, like GitHub's `dir="auto"`. Alignment uses
  `text-align: start` so RTL paragraphs align right.
- Wide tables: `overflow-wrap: anywhere` on whole cells lowers their min-content width, so ordinary
  words break mid-word ("Colum n"). It is applied only to links and code inside cells; the cells
  themselves use `break-word`.
