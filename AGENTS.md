# Working Guidelines: convpdf

**IMPORTANT: EXPLORE THE CODEBASE THOROUGHLY AND ANALYZE ALL SYSTEM DEPENDENCIES BEFORE STARTING ANY TASK.**

## Agent Responsibilities
- **MAINTAIN THIS DOCUMENT**: `AGENTS.md` is a living artifact. You **MUST** proactively update, rewrite, and expand these guidelines as the codebase evolves, ensuring they remain the definitive and most useful resource for future agents.

## Core Philosophy
- **ROBUST & RELIABLE**: Implementation **MUST** be correct, well-behaved, and handle edge cases gracefully. **NO HACKS.**
- **SANE DEFAULTS**: The tool must be **GREAT OUT OF THE BOX**—working beautifully and providing a high-quality experience with **ZERO CONFIGURATION**, while remaining flexible.
- **PREDICTABLE POWER**: Aim for feature-rich, high-fidelity results with zero weirdness. Avoid implicit behavior that violates sane defaults.
- **EXACT FIDELITY**: What is rendered in the browser **MUST BE EXACTLY** what appears in the PDF.
- **REASONABLE PERFORMANCE**: Optimize for efficiency (CPU/Memory) **WITHOUT SACRIFICING** reliability or code clarity.
- **LEVERAGE ECOSYSTEM**: Use high-quality, reliable external dependencies rather than reinventing the wheel. If a library does it better, **USE IT.**

## Technical Overview
`convpdf` is a high-fidelity Markdown-to-PDF engine built on **TypeScript** and **Puppeteer**. It prioritizes visual precision by treating PDF generation as a web-first rendering task.

- **Fidelity-First Pipeline**: Markdown is transformed into a modern HTML document via a structured pipeline: Frontmatter extraction -> Math protection -> Marked tokenization -> HTML templating.
- **Headless Precision**: Uses Puppeteer to render the final HTML, ensuring complex layouts, MathJax, Mermaid diagrams, and syntax highlighting are captured exactly as intended.
- **Concurrency & Parallelism**: Employs a **Page Pooling** strategy where a single browser instance is shared across multiple concurrent conversion tasks. Each task gets its own `Page`, ensuring isolation and resource efficiency.
- **Modular Design**: The system is partitioned into independent domains (Markdown, HTML, Styles, Utils) orchestrated by a central `Renderer`. This makes it easy to swap parsing logic, inject custom styles, or use it as a library.
- **Developer UX**: A powerful CLI supports glob expansion, watch mode, hierarchical configuration (`.convpdfrc*`), and bounded concurrency for high-throughput batch processing without destabilizing runtime resources.

## Codebase Overview
- **`bin/convpdf.ts`**: The **CLI ENTRY POINT**. Responsible for command-line argument parsing (Commander), config loading (`.convpdfrc*`), deterministic input expansion, output strategy validation (including directory structure mirroring for batch conversions), and serialized watch-mode conversion.
  - CLI option precedence is explicit: only user-provided flags override config values. Keep this guard so future Commander default behavior changes cannot silently clobber `.convpdfrc*` values.
  - Output strategy must stay extension-aware for both PDF and HTML modes. Single-file validation and collision checks must use the selected output format (`pdf` or `html`) consistently.
  - Watch mode must maintain output ownership state across `add/change/unlink` events to keep collision detection accurate over time.
  - Asset lifecycle commands (`convpdf assets install|verify|update|clean`) must remain deterministic and machine-readable when `--json` is requested.
  - Asset policy options (`assetMode`, `assetCacheDir`, `allowNetworkFallback`) must flow from config/CLI into renderer options without breaking CLI precedence rules.
  - `--asset-fallback/--no-asset-fallback` is only a CLI alias for `allowNetworkFallback`; keep this mapping explicit to avoid config/CLI divergence.
  - `--max-pages` / `maxConcurrentPages` must remain wired to renderer page leasing to keep Puppeteer memory usage predictable under high CLI concurrency.
  - Numeric CLI/config options that control concurrency (`concurrency`, `maxPages`, `maxConcurrentPages`) must fail fast on invalid/non-positive/out-of-range values instead of degrading into `NaN`/implicit clamping behavior.
  - Keep assets subcommand UX deterministic (`install|verify|update|clean`, `--help`, and `--cache-dir` parsing forms).
  - Preserve explicit-path handling for special characters (`()[]{}` `*` `?`) and do not mask non-`ENOENT` input discovery failures.
  - Watch mode should start on empty initial matches and only react within the original input scope.
- Rendering is automatic and syntax-driven for MathJax and Mermaid; keep it that way (no user-facing toggles).
- **`src/renderer.ts`**: The **ORCHESTRATOR**. Coordinates markdown parsing, HTML assembly, browser rendering, and PDF generation.
  - HTML mode should continue to use `renderHtml(...)` directly without launching a browser, while PDF mode uses Puppeteer.
  - PDF generation must compile markdown exactly once per document (avoid duplicate parse/tokenize/template work inside the PDF flow).
  - PDF rendering serves in-memory HTML via renderer-scoped localhost server instances keyed by effective asset cache directory; keep deterministic lifecycle management so concurrent conversions with different cache roots never invalidate each other's active document routes.
  - Render-server acquisition for a given cache root must be single-flight under concurrency (no duplicate localhost servers for the same key), and `Renderer.close()` must wait for in-flight server initialization before final shutdown.
  - `Renderer.close()` must also await in-flight browser launch (`init()`) before returning so cleanup cannot miss a late-created browser instance.
  - Each PDF job must use a unique document route (`/document/<id>.html`) and source route namespace (`/__convpdf_source/<id>/...`) so concurrent conversions remain isolated.
  - Route literals used by URL builders, request handlers, and URI rewrite logic must be centralized constants (no duplicated string literals across branches).
  - Local runtime assets are served from the same localhost origin during PDF rendering to avoid cross-origin issues with MathJax/Mermaid/font loading.
  - Runtime asset resolution is lazy/syntax-driven; documents without math/mermaid syntax must not require runtime assets.
  - After PDF generation, rewrite absolute `file:///...` and localhost source links to relative links, with fast-path detection to skip unnecessary PDF parsing.
  - Dynamic content waits (images, MathJax, Mermaid) are centralized and timeout-bounded; preserve these explicit waits when adjusting rendering behavior.
  - Page and localhost render-server lifecycle must be deterministic even if setup fails before navigation (no leaked pages on partial initialization failures).
  - Mermaid execution should happen only after `document.fonts.ready` to minimize label clipping and layout drift in final PDFs.
  - PDF rendering uses an explicit page lease pool (`maxConcurrentPages`) to bound simultaneous open pages; preserve deterministic page release on every success/failure path.
- **`src/assets/`**: Runtime asset management for offline rendering.
  - `manifest.ts` pins external runtime package versions and integrity metadata.
  - `manager.ts` handles user-cache install/verify/update/clean and archive extraction.
  - `resolve.ts` maps asset policy (`auto|local|cdn`) to concrete script/font URLs (local cache, localhost-served, or CDN).
  - Keep CDN fallback URLs and localhost runtime route prefixes centralized constants.
  - Memoize resolution by effective policy/cache tuple, but keep fallback-to-CDN decisions non-sticky so installs are detected in-process.
  - `allowNetworkFallback: false` is strict for both `auto` and `local`; missing local assets must fail fast with an actionable install command.
  - Asset downloads must be timeout-bounded, and install/clean operations must be lock-serialized per cache root to avoid concurrent staging races.
- **`src/markdown/`**: Markdown pipeline modules:
  - `frontmatter.ts` for frontmatter parsing/validation
  - `math.ts` for math protection/detection
    - Math detection must ignore dollar signs inside markdown link/image destinations (including nested-parenthesis URLs) so strict local asset policy does not fail on non-math documents.
  - `mermaid.ts` for mermaid-fence detection
  - `marked.ts` for Marked setup/extensions/safe links, callout/alert parsing (`> [!note]`, `> [!NOTE]`), and strict line-only `[TOC]` placeholder tokenization.
  - `toc.ts` for TOC generation; preserve hierarchical nested-list output (`<ul>` within parent TOC entries) so heading depth is reflected semantically, not only via indentation classes.
- **`src/html/template.ts`**: HTML document assembly with safe token replacement and optional MathJax/Mermaid script injection.
  - Template file loading should be memoized by absolute path within a process to remove redundant filesystem reads during multi-file conversions.
  - Math rendering is on MathJax v4 and Mermaid v11 with runtime URL injection; keep delimiter config and MathJax loader/font path wiring aligned with upstream docs.
- **`src/utils/`**: Shared helpers:
  - `html.ts` for escaping/sanitization
  - `validation.ts` for margin/format/toc-depth validation
  - Href sanitization for rendered HTML must reject `file:` links and protocol-relative URLs (`//...`) (relative links remain allowed); only explicit web-safe protocols should pass.
- **`src/types.ts`**: The **TYPE DEFINITIONS**. Contains interfaces and types used throughout the project to ensure strict type safety.
- **`src/styles/`**: Contains the **DESIGN DNA**. `default.css` provides the professional document layout, and `github.css` handles syntax highlighting themes.
  - Default layout constraints (`max-width`, centered body padding/background baseline) are scoped to the built-in template body class (`.convpdf-default-layout`) so custom templates/packs own page framing deterministically.
  - Default print pagination must allow `table` and `pre` content to split across pages (no forced pre-break when they do not fit), while still keeping headings/callouts/TOC visually stable.
  - Print table sizing must remain content-driven (`table-layout: auto`) so column widths adapt to cell content instead of flattening into rigid/equal-width columns.
- **`tests/`**: The **QUALITY GATE**. Consolidated into `unit.test.ts` (logic/parsing) and `cli.test.ts` (integration/E2E).
  - CLI tests run in a shared suite-scoped temp root with per-case subdirectories; keep this pattern to reduce filesystem churn while preserving isolation.
  - Keep regression coverage that conversion leaves no `convpdf-*` temp artifacts when `TMPDIR`/`TMP`/`TEMP` are scoped to a case-local directory.
  - Keep CLI E2E execution deterministic (`describe.sequential`, color-disabled output assertions, explicit child-process timeout).
  - Keep targeted regression coverage for config/template failures, markdown edge cases (TOC/math/page-break/link sanitization), output-format semantics, asset policy/commands, and renderer lifecycle races.
- **`examples/`**: Canonical real-world scenarios and fidelity probes used for **BOTH DOCUMENTATION AND REGRESSION TESTING**.
  - The exhaustive suite lives directly under `examples/`. Keep scenarios focused and non-overlapping:
    - `core-features.md`: baseline markdown features, emoji, wrapping stress, page breaks, and cross-file navigation.
    - `callouts-alerts.md`: Obsidian callouts and GitHub alert syntax coverage (including fallback blockquotes).
    - `math-heavy.md`: all advanced MathJax stress cases (inline/display/matrix/alignment/nesting/escaping).
    - `mermaid-diagrams.md`: consolidated flowchart + sequence diagram coverage.
    - Remaining files validate targeted concerns (TOC depth/collisions, edge cases, custom headers/footers, relative assets, syntax breadth, advanced styles, config-local resolution).
 - `examples/templates/` contains multiple full config/template/style packs (`executive-brief`, `academic-journal`, `product-launch`, `engineering-rfc`) with per-pack `sample.md` files; treat these as reusable presets and keep each pack self-contained.
  - Prefer extending existing canonical files over adding new top-level `examples/*.md` unless a new scenario cannot fit without reducing clarity.
- **`.github/workflows/`**: CI/CD automation:
  - `ci.yml` runs a multi-version quality gate (typecheck/lint/format/build/test) plus package smoke checks (`npm pack --dry-run` and CLI help validation)
  - `release.yml` validates release tags against `package.json`, verifies ancestry from `main`, publishes via npm trusted publishing (`id-token` + provenance), and creates/updates GitHub Releases with generated notes

## 🚀 Agent Protocol

### 1. Mandatory Orientation
- **IN-DEPTH CODEBASE EXPLORATION**: Regardless of task size, start with a direct source-level survey of architecture, types, configs, and dependencies. Do not rely on assumptions.

### 2. Operational Rigor
- **CRITICAL MINDSET**: Do not assume the codebase is perfect. Be alert for missing logic, edge cases, or features that appear complete but are fragile.
- **PRIORITIZE COHESION, DELETE STALE COMPLEXITY**: Prioritize codebase health over historical patterns. Aggressively remove obsolete branches, dead paths, compatibility-only checks, and unused abstractions. Prefer direct rewrites that make behavior obvious, deterministic, and maintainable.
- **COHESION PASS**: After any change, perform a targeted sanity sweep to ensure the new behavior is **fully wired** across configs, CLI options, defaults, tests, and documentation.
- **LIFECYCLE HYGIENE**: CLI and renderer changes must preserve deterministic cleanup for browser pages, watchers, and signal handlers in both one-shot and watch modes.
- **VERIFICATION**: Run `npm run ci` before considering work complete. For release workflow edits, also validate local tag flow (`npm version` + pushed tags).
- **SYSTEM INTEGRITY**: Any change that introduces new build artifacts, temporary directories, or runtime dependencies **MUST** be reflected in `.gitignore` and documented in `README.md`.

### 3. Communication & UX
- **ASSERTIVE EXPERTISE**: If a request is ambiguous, technically flawed, or contradicts project patterns, **PUSH BACK**. Propose better alternatives.
- **UX FIRST**: Prioritize the end-user experience. Do not compromise the CLI's usability or the PDF's visual quality to simplify implementation.

## Testing Strategy
- **REFLEXIVE & CONSTANT**: Test continuously; do not batch all validation at the end.
- **MULTI-LAYERED**:
    - **UNIT TESTS**: Verify individual functions (frontmatter, TOC, HTML assembly).
    - **INTEGRATION TESTS**: Verify renderer interaction with filesystem/Puppeteer.
    - **END-TO-END (E2E) TESTS**: Verify full CLI flow from Markdown input to PDF output.
- **REGRESSION TESTING**: Run `npm run build && npm test` before/after substantial behavior changes.
- **DETERMINISTIC I/O**: Prefer case-local temp directories and deterministic output checks; avoid assertions that depend on ambient machine state (global `/tmp`, unrelated concurrent processes, terminal color mode).

## Coding Standards
- **TYPESCRIPT & ESM**: Strict adherence to **TYPESCRIPT** and **ES MODULES.**
- **NO ANY**: The `any` type is **STRICTLY PROHIBITED.** Use precise interfaces, unions, or `unknown` with type guards.
- **CLARITY OVER CLEVERNESS**: Code should be intuitive, readable, and easy to maintain. **AVOID UNNECESSARY ABSTRACTIONS.**
- **ASYNC/AWAIT**: Proper handling of **ASYNCHRONOUS OPERATIONS** for FS and Browser control is **MANDATORY.**
- **STANDARD COMPLIANT**: Follow modern TypeScript best practices and Puppeteer/Marked usage patterns. **NO DEPRECATED APIS.**
- **ERROR CHAINING**: When rethrowing inside `catch`, preserve the original error via `new Error(message, { cause: error })` to satisfy linting and keep actionable diagnostics.
- **ERROR UTILITIES**: Prefer `src/utils/errors.ts` helpers (`toErrorMessage`, `ensureError`, `ignoreError`) over ad-hoc inline error conversion or empty catch callbacks.
- **ERRNO TYPE GUARDS**: Use `isErrnoException` for narrowing Node filesystem/network error codes; do not inline-cast unknown errors.
- **DEFAULTS DRYNESS**: Shared defaults (`DEFAULT_MARGIN`, `DEFAULT_PAPER_FORMAT`, `DEFAULT_TOC_DEPTH`) live in `src/utils/validation.ts`; do not duplicate these literals elsewhere.
- **STRICT EQUALITY**: Use `===` / `!==` only.
- **EXHAUSTIVE SWITCHES**: All switch-based branching over unions/enums must be exhaustive and lint-clean.
- **UNKNOWN CATCH CALLBACKS**: Promise `.catch((error) => ...)` callbacks must type `error` as `unknown`.
- **LINTING & FORMATTING**: All code must pass `eslint` and `prettier`. Run `npm run lint` and `npm run format:check` before committing.
