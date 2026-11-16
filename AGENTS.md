# AGENTS.md

convpdf converts Markdown to PDF: a CLI plus an optional web UI (`convpdf serve`). It renders
with markdown-it and prints with the user's own headless Chrome.

## Goals

- Support all of GitHub and Obsidian Markdown.
- Nice, tasteful, standard styling.
- Intuitive to use: sensible defaults, few required flags.
- Very fast. Measure before and after any change that could affect speed.
- Backwards compatibility doesn't matter. Change what needs changing.

## Working here

- Run from source with `node src/cli.ts`. `bin/convpdf.js` prefers `dist/`, so rebuild
  (`npm run build`) or bypass it after changing `src/`.
- `npm run check` runs the type check and all tests. The PDF tests need Chrome and Poppler.
- Test thoroughly: add tests with every fix or feature.
- Commit frequently, in small steps that each pass `npm run check`.
- Keep the docs current as you go: `README.md` for users, `docs/ARCHITECTURE.md` for how it
  works, `docs/NOTES.md` for decisions, measurements and gotchas. Read the last two before
  bigger changes.
- Releases are published by CI from a version tag; see "Releasing" in `docs/NOTES.md`.

## Don't break

- Scripts from documents must never run. Every script convpdf adds needs the CSP nonce.
- Never put `transform` or `opacity` on elements that repeat, such as TOC entries. Chrome prints
  them very slowly.
