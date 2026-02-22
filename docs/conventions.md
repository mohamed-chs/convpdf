# Programming Conventions

This document defines repository-wide coding conventions from pedantic details to architectural guardrails.

## Pedantic Conventions

- Use `type` imports for type-only symbols.
- Use strict equality (`===`, `!==`) consistently.
- Avoid ad-hoc error message extraction. Use `toErrorMessage(error)` from `src/utils/errors.ts`.
- Avoid inline casts for filesystem errors (for example `error as NodeJS.ErrnoException`).
  Use `isErrnoException(error)` from `src/utils/errors.ts`.
- Avoid inline no-op catches. Use `ignoreError` from `src/utils/errors.ts` when intentional.
- Use `unknown` for Promise `.catch(...)` callback parameters.
- Avoid hard-coded runtime CDN URLs in multiple modules. Reuse
  `CDN_MATHJAX_SRC` and `CDN_MERMAID_SRC` from `src/assets/resolve.ts`.
- Avoid repeating internal runtime route literals (`/__convpdf_assets/...`, `__convpdf_source`).
  Reuse shared constants so server handlers, URL builders, and rewriters cannot drift.

## Core Code Conventions

- Re-throw only `Error` instances. Use `ensureError(error)` when converting unknown throws.
- When throwing inside `catch`, preserve cause context:
  `throw new Error(message, { cause: error })`.
- Keep shared defaults in one place to prevent drift:
  - `DEFAULT_MARGIN`
  - `DEFAULT_PAPER_FORMAT`
  - `DEFAULT_TOC_DEPTH`
    These live in `src/utils/validation.ts`.
- Keep cleanup deterministic on all success/failure paths (watcher, renderer, page, and server lifecycle).
- Keep option and config parsing explicit, fail-fast, and type-safe.

## Architectural Conventions

- Rendering behavior must remain deterministic and isolated across concurrent jobs.
- Asset policy resolution (`auto|local|cdn`) must remain explicit and predictable.
- Any intentionally suppressed failure must be scoped, explicit, and justified by surrounding flow.

## Enforcement

Conventions are enforced through ESLint and CI:

- `@typescript-eslint/switch-exhaustiveness-check`
- `@typescript-eslint/use-unknown-in-catch-callback-variable`
- `@typescript-eslint/consistent-type-imports`
- `@typescript-eslint/no-floating-promises`
- `eqeqeq`

Run:

```bash
npm run ci
```
