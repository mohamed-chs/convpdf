# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` is a symlink to this file.

mdpdf is a Markdown-to-PDF CLI with an optional web UI (`mdpdf serve`). It renders GitHub and
Obsidian flavored Markdown with markdown-it and prints it with the user's own headless Chrome
over a small DevTools-protocol client of our own. Speed and output quality are the main goals.
Backwards compatibility doesn't matter: change interfaces freely, but keep the docs in step.

Read `docs/ARCHITECTURE.md` for the module map and pipeline, and `docs/NOTES.md` for decisions,
measurements and gotchas, before making non-trivial changes.

## Commands

```sh
node src/cli.ts file.md            # run from source (Node runs TypeScript natively)
node src/cli.ts serve [folder]     # web UI from source (bundles the UI on the fly with esbuild)
npm run typecheck                  # tsc, no emit
npm test                           # node:test, all of test/**/*.test.ts
node --test test/obsidian.test.ts  # one file
node --test --test-name-pattern="heading links" test/obsidian.test.ts
npm run check                      # typecheck + tests: run before every commit
npm run build                      # esbuild bundle into dist/
MDPDF_DEBUG=1 node src/cli.ts f.md # timing trace on stderr
```

`bin/mdpdf.js` runs `dist/cli.js` when it exists and falls back to `src/cli.ts` otherwise. After
changing `src/`, either run `node src/cli.ts` or rebuild; a stale `dist/` silently runs old code.

PDF tests need Chrome (found via `MDPDF_CHROME`, `CHROME_PATH`, Puppeteer's cache, standard
locations or `PATH`) and Poppler (`pdftotext`, `pdfinfo`, `pdffonts`). They are skipped when
Chrome is missing; don't mistake skips for passes.

## Code conventions

- TypeScript run directly by Node: ESM, imports with `.ts` extensions, and only erasable syntax
  (`erasableSyntaxOnly`), so no enums, namespaces or constructor parameter properties.
- Node built-ins as `node:` imports. Keep runtime dependencies few; the browser client, PDF
  post-processing and the server are hand-written on purpose.
- Lazy-load anything heavy (Shiki, KaTeX, mhchem, Mermaid, YAML) only when a document needs it.
  Start-up time is measured; don't add top-level imports of large modules to the CLI path.
- The markdown pipeline is parse (sync) → prepare (async: embeds, grammars, KaTeX) → render
  (sync). markdown-it's renderer must stay synchronous, so anything async belongs in prepare.
- Heading ids are only final after rendering. Links to headings are emitted as `#mdpdf-ref-N`
  placeholders and resolved by `resolveHeadingRefs()`; use `headingRef()` for new link kinds.
- Every local URL goes through the `AssetResolver` (file URLs for print, `/fs/…` for the web UI,
  relative paths for HTML export). Don't build `file://` URLs by hand.
- Comments explain why, not what. Keep them short.

## Security rules

Documents are untrusted input. These are tested and must stay true:

- Scripts from documents never run. Every page has a CSP that only allows scripts carrying the
  per-process nonce. Every script mdpdf adds needs `nonce`. The nonce must stay constant within a
  process, or the web preview reloads on every keystroke.
- Raw HTML `<meta>` tags are stripped, and frames are limited to `http:`/`https:`.
- The server binds to localhost, rejects foreign `Host` headers, requires `X-Mdpdf` plus a
  same-origin `Origin` on writes, confines paths to the served folder and serves only asset types.

When touching any of this, check that the relevant test fails with your change reverted.

## Styling and print performance

- Themes are `themes/base.css` (structure, print rules, CSS variables) plus `default.css` and
  `serif.css`. Prefer CSS variables and logical properties (`text-align: start`).
- Never put `transform`, `opacity` or filters on elements that repeat (TOC entries, links, table
  cells): Chrome prints each one far more slowly. Measure print time on a long document after
  style changes.
- Fonts must be static (not variable) so Skia embeds them as TrueType. `pdffonts` must show no
  Type 3 fonts; a test checks this.

## Tests

- Add a test with every fix or feature, in the file that matches the area (`markdown`, `obsidian`,
  `pdf`, `cli`, `server`, `cache`, `postprocess`). `test/helpers.ts` has `render()` and `html()`
  for markdown-only tests, which are fast and need no browser.
- `test/helpers.ts` points `MDPDF_CACHE_DIR` at a temporary folder so tests never touch the real
  Mermaid cache. Keep it that way in new test entry points.
- `test/commonmark.test.ts` runs all CommonMark spec examples with every plugin enabled. A new
  syntax extension that changes a spec example must be listed in `EXPECTED_DIFFERENCES` with the
  reason, and only if the difference is intended.
- For PDF output, assert on `pdftotext`/`pdfinfo` output or the bytes, not on timing.
- Fixtures live in `test/fixtures/` (`plain/` and an Obsidian `vault/`). Write throwaway files to
  a `mkdtempSync` folder and remove them in `finally`.

## Documentation

Update docs in the same commit as the change:

- `README.md`: user-facing features, options and examples. Keep `--help` in `src/run.ts` in sync.
- `docs/ARCHITECTURE.md`: modules and how the pipeline works.
- `docs/NOTES.md`: decisions, gotchas, and a row in the performance log for any measured speed
  change (before → after, on what document).

## Commits

- Commit small, self-contained changes often, each passing `npm run check`.
- Subject in the imperative, sentence case, no trailing period, describing the effect
  (e.g. "Print TOCs much faster: no transform on leader dots").
- `dist/`, PDFs (except test fixtures) and `test/output/` are git-ignored. Don't commit them.
