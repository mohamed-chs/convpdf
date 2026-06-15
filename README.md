# convpdf

Convert Markdown to high-quality PDF with Marked + Puppeteer.

<a href="https://www.npmjs.com/package/convpdf"><img src="https://img.shields.io/npm/v/convpdf?style=for-the-badge&logo=npm" alt="NPM Version"></a>

## Features

- Zero-config defaults.
- High-fidelity rendering for MathJax v4, Mermaid, Highlight.js, tables, and callouts.
- TOC (`[TOC]`), footnotes, and `<!-- PAGE_BREAK -->` support.
- Custom CSS/template/header/footer.
- Batch conversion + watch mode.
- Portable relative links in generated output.

## Install

```bash
npm install -g convpdf
```

## Quick Usage

```bash
# Basic conversion
convpdf input.md

# Batch conversion
convpdf "docs/*.md" -o dist/

# Watch scope stays tied to the original input pattern
convpdf "docs/**/*.md" --watch -o pdf/

# HTML output
convpdf input.md --output-format html
```

Run `convpdf --help` for the full option list.

## Common Options

- `-o, --output <path>` output directory or file.
- `--output-format <pdf|html>` / `--html` output format.
- `-w, --watch` enable watch mode.
- `-j, --concurrency <n>` conversion concurrency (default `5`, max `32`).
- `--max-pages <n>` max concurrent Puppeteer pages (default `8`).
- `-c, --css <path>` / `-t, --template <path>` custom styling/template.
- `--header <path>` / `--footer <path>` PDF header/footer.
- `-m, --margin <margin>` / `-f, --format <format>` PDF layout.
- `--toc` / `--toc-depth <n>` table of contents.
- `--asset-mode <auto|local|cdn>` / `--asset-cache-dir <path>` / `--asset-fallback` runtime asset policy.

## Runtime Setup

`convpdf` does not download Chrome or rendering assets during `npm install`. On the first PDF
render, it installs Chrome into the package-local cache if no executable is already configured or
available. Runtime assets for MathJax and Mermaid are installed on demand when a document uses math
or Mermaid. Plain Markdown and HTML-only output do not need Chrome.

```bash
convpdf assets install
convpdf assets verify
convpdf assets update
convpdf assets clean
```

Default policy is `auto` (install/use local assets, fallback to CDN if setup fails). Strict offline
mode:

```bash
convpdf input.md --asset-mode local --no-asset-fallback
```

## Configuration

Supported config files: `.convpdfrc`, `.convpdfrc.json`, `.convpdfrc.yaml`, `.convpdfrc.yml`.

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

Config-relative paths are resolved from the config file location.

## Templates and Conventions

- Template packs: `examples/templates/` (`executive-brief`, `academic-journal`, `product-launch`, `engineering-rfc`).
- Coding conventions: `docs/conventions.md`.

## Troubleshooting

### Missing Fonts on Linux

```bash
# Ubuntu/Debian
sudo apt-get install fonts-noto-color-emoji fonts-liberation
```

### Browser Launch Issues

Use `--executable-path` (or `PUPPETEER_EXECUTABLE_PATH`) when system Chromium dependencies differ.

### First PDF Run Installs Chrome

If no browser executable is configured, the first PDF conversion installs Chrome into a
package-local `.puppeteer-cache`. Use `--executable-path` or `PUPPETEER_EXECUTABLE_PATH` to use a
system browser instead.
