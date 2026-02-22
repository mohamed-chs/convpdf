## Quality Gate

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
npm test
```

Or run everything in one command:

```bash
npm run ci
```

## Coding Conventions

Follow `docs/conventions.md` for pedantic-to-architectural code standards enforced by lint/CI.

## Linting and Formatting

```bash
npm run lint
npm run lint:fix
npm run format
npm run format:check
```

## Development

```bash
npm install
npm run build
npm test

# Run in dev mode without building dist/
npm run dev -- input.md
```
