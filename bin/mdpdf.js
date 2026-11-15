#!/usr/bin/env node
// Use the bundled build when present (faster start-up), else run the sources
// directly with Node's built-in TypeScript support.
import { existsSync } from 'node:fs';

const dist = new URL('../dist/cli.js', import.meta.url);
await import(existsSync(dist) ? dist.href : new URL('../src/cli.ts', import.meta.url).href);
