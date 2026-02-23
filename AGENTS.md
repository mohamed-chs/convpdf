# Working Guidelines: convpdf

Start every task with a direct source-level scan of architecture, types, configs, and dependencies. Do not rely on assumptions.

## Ownership
- Keep this file current. When behavior or architecture changes, update these rules in the same PR.

## Core Principles
- Reliability first: no hacks, deterministic behavior, graceful edge-case handling.
- Zero-config UX with sane defaults; customization should remain optional.
- Browser/PDF fidelity is non-negotiable.
- Optimize for practical performance without obscuring correctness.
- Prefer strong external libraries over custom reimplementation.

## Architecture Snapshot
- `bin/convpdf.ts`: CLI entrypoint/orchestration (Commander wiring, conversion loop, watch lifecycle, signal handling).
- `src/cli/*`: CLI modules for config/runtime option resolution, input discovery/matching, output path strategy, and assets subcommands.
- `src/renderer.ts`: orchestrates markdown -> HTML -> browser rendering/PDF; HTML mode must bypass Puppeteer.
- `src/assets/*`: runtime asset manifest, install/verify/update/clean, policy resolution (`auto|local|cdn`).
- `src/markdown/*`: frontmatter, math protection/detection, Mermaid detection, Marked setup/extensions, TOC generation.
- `src/html/template.ts`: template assembly and runtime script injection.
- `src/utils/*`: validation, sanitization, error utilities.
- `tests/*`: `unit.test.ts` + `cli.test.ts` as regression gate.

## Non-Negotiable Behavior
- CLI precedence: only explicitly passed flags override `.convpdfrc*` values.
- Output checks must stay output-format aware for both PDF/HTML.
- Watch mode must preserve output ownership across add/change/unlink and stay scoped to original inputs.
- `--asset-fallback` remains an alias for `allowNetworkFallback`.
- Concurrency controls (`concurrency`, `maxPages`, `maxConcurrentPages`) must fail fast on invalid values.
- PDF path: compile markdown once per document.
- PDF rendering must use isolated per-job routes (`/document/<id>.html`, `/__convpdf_source/<id>/...`).
- Render-server lifecycle must be deterministic and isolated by effective asset cache root.
- Page/browser/server cleanup must be deterministic on success and failure paths.
- Runtime asset loading remains syntax-driven; docs without math/mermaid must not require runtime assets.
- `allowNetworkFallback: false` must fail fast when local assets are missing.
- Link sanitization must block `file:` and protocol-relative URLs.

## Rendering and Styling Guardrails
- Keep dynamic content waits explicit and timeout-bounded (images, MathJax, Mermaid).
- Run Mermaid after `document.fonts.ready` to reduce layout drift.
- Preserve PDF post-processing that rewrites absolute `file:///` and localhost source links to relative links.
- Built-in layout framing belongs to `.convpdf-default-layout`; custom templates own their own framing.
- Print defaults should allow `table`/`pre` splitting and use content-driven table sizing (`table-layout: auto`).

## Code and Error Standards
- TypeScript + ESM only. No `any`.
- Prefer clear code over abstractions that hide behavior.
- Use strict equality and exhaustive switch handling.
- Use shared validation defaults from `src/utils/validation.ts`.
- Preserve causes on rethrow (`new Error(message, { cause })`).
- Prefer `src/utils/errors.ts` helpers (`toErrorMessage`, `ensureError`, `ignoreError`, `isErrnoException`).

## Testing and Verification
- Test continuously, not only at the end.
- For substantial behavior changes: run `npm run build && npm test` during development.
- Before completion: run `npm run ci`.
- Keep tests deterministic (case-local temp dirs, color-stable assertions, bounded child-process timeouts).

## Documentation and Repo Hygiene
- If changes add runtime/build artifacts or temporary dirs, update `.gitignore` and `README.md`.
- Prefer extending existing canonical examples over adding overlapping new ones.
