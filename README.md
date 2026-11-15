# mdpdf

Convert Markdown to clean, well-typeset PDFs from the command line or a local web UI.
mdpdf handles everything GitHub and Obsidian render: tables, task lists, footnotes,
alerts and callouts, math, Mermaid diagrams, syntax highlighting, wikilinks and embeds.

```sh
mdpdf README.md            # → README.pdf
```

- **Complete syntax support.** CommonMark, GitHub Flavored Markdown, and Obsidian syntax.
  See [what's supported](#markdown-support).
- **Good-looking defaults.** Inter and JetBrains Mono (or Source Serif 4 with `--theme serif`),
  GitHub-style code colours, page numbers, a PDF outline, and real tables of contents with
  page numbers. Text is selectable and the PDF is tagged.
- **Fast.** A single file converts in about a quarter of a second. Batches run in parallel,
  around 25 ms per document. Watch mode re-renders on save.
- **No surprises.** Fonts are bundled, so output looks the same on every machine. Images, embeds
  and links resolve the way they do in Obsidian.

## Install

```sh
npm install -g mdpdf
```

Requires Node.js 22.18 or newer and Chrome, Chromium or Microsoft Edge (mdpdf drives the browser
you already have, so there's no 150 MB download). If the browser is in an unusual place, pass
`--chrome <path>` or set `MDPDF_CHROME`.

## Usage

```sh
mdpdf notes.md                      # notes.pdf next to the file
mdpdf notes.md -o out/report.pdf    # choose the output file
mdpdf docs/ -o pdf/                 # convert a folder, mirroring its structure
mdpdf "chapters/*.md" -o book.pdf   # merge several files into one PDF
mdpdf notes.md --toc --theme serif  # table of contents, serif typography
mdpdf notes.md -w --open            # open the PDF and re-render on every save
cat notes.md | mdpdf - > notes.pdf  # stdin to stdout
mdpdf notes.md --html               # standalone HTML instead of PDF
```

Run `mdpdf --help` for the full list of options.

### Web UI

```sh
mdpdf serve [folder]                # http://localhost:4400
```

The web UI has a file list, an editor, a live preview that follows your scroll position, and an
exact PDF preview. You can switch theme, paper size, orientation and table of contents, and
download the PDF. It saves to disk (<kbd>Ctrl</kbd>+<kbd>S</kbd>) and picks up changes made in
other editors. You can also drop a Markdown file onto the page.
Shortcuts: <kbd>Ctrl</kbd>+<kbd>E</kbd> downloads the PDF, <kbd>Ctrl</kbd>+<kbd>B</kbd> toggles the
file list, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> switches between preview and PDF.

The server listens on localhost only. It rejects requests from other sites and only serves
files the document uses.

## Markdown support

| Feature | Syntax |
| --- | --- |
| CommonMark | everything, including raw HTML (`<kbd>`, `<sub>`, `<details>`, ...) |
| Tables | GFM pipe tables with alignment |
| Task lists | `- [ ]`, `- [x]`, plus Obsidian statuses `[/]` `[-]` `[!]` `[?]` ... |
| Strikethrough, highlight | `~~text~~` or `~text~`, `==text==` |
| Autolinks | URLs, `www.` links and emails, as on GitHub |
| Footnotes | `[^1]`, `^[inline footnotes]` |
| Alerts / callouts | GitHub `> [!NOTE]` ... `> [!CAUTION]`; Obsidian `> [!tip] Title`, all types and aliases, nesting, foldable `+`/`-` |
| Math | `$inline$`, `$$display$$`, GitHub's `` $`inline`$ `` and ` ```math ` blocks; KaTeX with mhchem (`\ce{H2O}`) and `\def` macros |
| Diagrams | ` ```mermaid ` (flowcharts, sequence, class, state, ER, Gantt, pie, git graphs, mind maps, timelines, ...) |
| Code | Syntax highlighting for 200+ languages; `title="file.ts"`; `diff` colouring; optional line numbers |
| Headings | GitHub-compatible anchor ids, so `[link](#some-heading)` works |
| Emoji | `:tada:` shortcodes |
| Definition lists, abbreviations | `Term` / `: Definition`; `*[HTML]: Hyper Text Markup Language` |
| Wikilinks | `[[Note]]`, `[[Note\|alias]]`, `[[Note#Heading]]`, `[[#^block-id]]` |
| Embeds | `![[image.png\|300]]`, `![[Note]]`, `![[Note#Heading]]`, `![[Note#^block-id]]`, recursively |
| Obsidian extras | `%%comments%%`, `#tags`, `^block-ids`, image sizes `![alt\|300x200](img.png)` |
| Table of contents | `--toc`, or `[TOC]` / `[[_TOC_]]` / `${toc}` anywhere in the document |
| Page breaks | `\pagebreak`, `\newpage` or `<!-- pagebreak -->` on their own line |
| Front matter | YAML; sets title, author, date, keywords and any option |

Links between files you convert together become links between the PDFs (or anchors in a merged
PDF). Inside an Obsidian vault (a folder with `.obsidian/`), notes and attachments resolve by name
from anywhere in the vault, and line breaks follow your "Strict line breaks" setting.

## Options

Options can come from the command line, front matter, or a config file. The command line wins
over front matter, which wins over the config file.

| Option | CLI | Default |
| --- | --- | --- |
| Theme | `-t, --theme default\|serif\|file.css` | `default` |
| Extra CSS | `--css file.css` (repeatable) | |
| Paper | `-p, --paper A4\|Letter\|Legal\|A3\|A5\|"210mm 297mm"` | Letter in the Americas, A4 elsewhere |
| Orientation | `-l, --landscape` | portrait |
| Margins | `-m, --margin "20mm"` (CSS shorthand) | `18mm 18mm 20mm` |
| Font size | `--font-size 11pt` | theme (10.5pt) |
| Table of contents | `--toc`, `--toc-depth 3`, `--toc-title Contents` | off |
| Page breaks | `--break-before h1\|h2` | none |
| Header / footer | `--header "{title}\|\|{date}"`, `--footer "{page} / {pages}"`, `--no-page-numbers` | page numbers |
| Code | `--line-numbers`, `--code-theme github-dark` (any [Shiki theme](https://shiki.style/themes)) | `github-light` |
| Line breaks | `--breaks` (single newlines become line breaks) | off, except in Obsidian vaults |
| Front matter | `--frontmatter` (show as a table), `--no-title-block` | hidden; title block shown |
| Metadata | `--title`, `--author` | from front matter / first heading |
| Diagrams | `--mermaid-theme default\|neutral\|dark\|forest` | matches the theme |

Header and footer templates are `left|center|right` (or `left|right`, or just `center`) and may use
`{page}`, `{pages}`, `{title}`, `{author}`, `{date}` and `{file}`.

### Front matter

```yaml
---
title: Quarterly Report       # PDF title and title block
author: Ada Lovelace
date: 2026-11-15
tags: [finance, q3]           # PDF keywords
mdpdf:                        # any option (also accepted: pdf:)
  toc: true
  paper: Letter
  footer: "{title}||{page} / {pages}"
---
```

### Config file

mdpdf looks for `mdpdf.yaml`, `mdpdf.yml` or `mdpdf.json` (or a dot-prefixed version) in the input's
folder and its parents. Paths in the file are relative to the file.

```yaml
theme: serif
paper: A4
css: [styles/brand.css]
footer: "Acme Corp||{page}"
```

## Styling

Themes are plain CSS. To adjust one, pass a stylesheet with `--css`. Most changes only need the
custom properties:

```css
:root {
  --font-body: 'Georgia', serif;
  --font-size: 11pt;
  --link: #8250df;
  --code-bg: #f4f1ea;
  --callout-note: 9, 105, 218;   /* r, g, b */
}
h1 { text-transform: uppercase; letter-spacing: 0.04em; }
```

`--theme my-theme.css` replaces the built-in look entirely, keeping only the structural base
styles. Page size, margins, headers and footers come from options rather than CSS.

## Performance

A single-page document takes about 0.25 s end to end. Half of that is Chrome starting up, which
mdpdf launches before it does anything else. Further documents in the same run reuse the browser
and pages: a folder of 30 documents converts in about 0.8 s. Heavy dependencies (Shiki grammars,
KaTeX, Mermaid) load only when a document needs them. `MDPDF_DEBUG=1` prints a timing trace.

## Development

```sh
npm install
npm test            # unit, end-to-end and CLI tests (end-to-end ones need Chrome)
npm run typecheck
npm run build       # bundle to dist/ (optional: the sources run directly on Node 22.18+)
node src/cli.ts examples/showcase.md --toc
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works and
[docs/NOTES.md](docs/NOTES.md) for design decisions and measurements.

## License

MIT
