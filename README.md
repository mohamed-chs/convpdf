# convpdf

Convert Markdown to high-quality PDF using Node.js, Marked, and Puppeteer.

<a href="https://www.npmjs.com/package/convpdf"><img src="https://img.shields.io/npm/v/convpdf?style=for-the-badge&logo=npm" alt="NPM Version"></a>

## Features

- **Zero-Config**: Beautiful defaults out of the box.
- **High Fidelity**: Professional rendering of math (MathJax v4), Mermaid diagrams, code (Highlight.js), and tables.
- **Advanced Layout**: Support for [TOC], footnotes, `<!-- PAGE_BREAK -->`, Obsidian callouts (`> [!note]`) and GitHub alerts (`> [!NOTE]`).
- **Customizable**: Override CSS, templates, headers, and footers.
- **Batch Processing**: Convert multiple files using glob patterns.
- **Watch Mode**: Live-reload PDFs as you edit your Markdown, while honoring the exact original input scope (file, directory, or glob).
- **Portable Links**: Generated HTML/PDF keeps relative file links portable instead of embedding machine-specific absolute `file:///` paths.

## Usage

```bash
# Basic conversion
convpdf input.md

# Multiple files with custom output directory
convpdf "docs/*.md" -o results/

# Custom styles and TOC
convpdf input.md --css styles.css --toc

# Watch mode
convpdf "docs/**/*.md" --watch -o pdf/

# Batch conversion with concurrency
convpdf "docs/*.md" -o dist/ -j 4

# Install offline runtime assets once
convpdf assets install
```

## Options

- `-o, --output <path>`: Output directory or file path.
- `--output-format <format>`: Output format (`pdf` or `html`, default: `pdf`).
- `--html`: Shortcut for `--output-format html`.
- `-w, --watch`: Watch for changes.
- `-j, --concurrency <number>`: Number of concurrent conversions (integer >= 1, default: 5, max: 32).
- `-c, --css <path>`: Custom CSS file.
- `-t, --template <path>`: Custom HTML template.
- `-m, --margin <margin>`: Page margin (default: 15mm 10mm).
- `-f, --format <format>`: PDF format (default: A4).
- `--header <path>`: Custom header template.
- `--footer <path>`: Custom footer template.
- `--toc`: Generate Table of Contents.
- `--toc-depth <depth>`: TOC depth from `1` to `6`.
- `--executable-path <path>`: Custom browser executable path.
- `--max-pages <number>`: Maximum number of concurrent browser pages used for PDF rendering (default: `8`).
- `--preserve-timestamp`: Preserve modification time from markdown file.
- `--asset-mode <mode>`: Runtime asset mode (`auto`, `local`, `cdn`; default: `auto`).
- `--asset-cache-dir <path>`: Runtime asset cache directory override.
- `--asset-fallback` / `--no-asset-fallback`: Enable/disable CDN fallback when local assets are missing.

## Offline Runtime Assets

`convpdf` can run fully offline for MathJax and Mermaid by installing runtime assets into a user cache.
These assets are only required when a document actually uses MathJax (`$...$`, `$$...$$`, `\\(...\\)`, `\\[...\\]`) or Mermaid fences.

```bash
# Install pinned runtime assets
convpdf assets install

# Verify cache integrity/presence
convpdf assets verify

# Refresh pinned assets
convpdf assets update

# Remove cached runtime assets
convpdf assets clean
```

By default, conversion uses `--asset-mode auto`:

- Uses local cached assets when installed.
- Falls back to CDN when local assets are unavailable.

For strict offline behavior (no CDN/network fallback at all):

```bash
convpdf input.md --asset-mode local --no-asset-fallback
```

`--no-asset-fallback` also applies to `--asset-mode auto`: if local runtime assets are not installed, conversion fails with an install hint instead of silently using CDN assets.

## Installation

```bash
npm install -g convpdf
```

## Conventions

Programming conventions and enforcement rules are documented in `docs/conventions.md`.

## Configuration

Supports `.convpdfrc`, `.convpdfrc.json`, `.convpdfrc.yaml`, and `.convpdfrc.yml`.

Example:

```yaml
margin: 15mm
format: A4
toc: true
tocDepth: 3
css: ./styles/custom.css
template: ./templates/report.html
header: ./templates/header.html
footer: ./templates/footer.html
assetMode: auto
assetCacheDir: ~/.cache/convpdf
allowNetworkFallback: true
maxConcurrentPages: 8
```

Paths in config files are resolved relative to the config file location.

## Template Packs

Ready-to-run configuration packs are available in `examples/templates/`.
Each pack includes:

- `.convpdfrc.yml`
- `template.html`
- `styles.css`
- Optional `header.html` and `footer.html`
- `sample.md` for quick preview

Available packs:

- `examples/templates/executive-brief`
- `examples/templates/academic-journal`
- `examples/templates/product-launch`
- `examples/templates/engineering-rfc`

Quick start:

```bash
cd examples/templates/executive-brief
convpdf ./sample.md -o ./output.pdf
```

## Troubleshooting

### Missing Fonts on Linux

If emojis or special characters aren't rendering correctly in the generated PDF, you might need to install additional fonts:

```bash
# Ubuntu/Debian
sudo apt-get install fonts-noto-color-emoji fonts-liberation
```

### Puppeteer Browser Issues

If you encounter errors launching the browser, you may need to install missing system dependencies for Chromium. You can also specify a custom browser path using the `--executable-path` flag or `PUPPETEER_EXECUTABLE_PATH` environment variable.

---

> Inspired by [simonhaenisch/md-to-pdf](https://github.com/simonhaenisch/md-to-pdf)
