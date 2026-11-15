/**
 * Production build:
 *   dist/cli.js (+ chunks)  the CLI and server, bundled (dependencies stay external)
 *   dist/ui/                the web UI (bundled editor + static files)
 *
 * Running from source works without a build; the bundle only makes start-up
 * faster (no TypeScript stripping, far fewer module resolutions).
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const start = performance.now();

rmSync(dist, { recursive: true, force: true });

await Promise.all([
  esbuild.build({
    entryPoints: [join(root, 'src/cli.ts')],
    outdir: dist,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    // Dependencies stay external: bundling them was measured to be slower
    // (it defeats lazy loading), and several ship assets resolved at run time.
    packages: 'external',
    minifySyntax: true,
    legalComments: 'none',
    chunkNames: '[name]-[hash]',
    logLevel: 'warning',
  }),
  esbuild.build({
    entryPoints: [join(root, 'src/server/ui/app.ts')],
    outfile: join(dist, 'ui/app.js'),
    bundle: true,
    format: 'esm',
    target: ['chrome115', 'firefox115', 'safari16'],
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  }),
]);

mkdirSync(join(dist, 'ui'), { recursive: true });
for (const file of ['index.html', 'app.css']) copyFileSync(join(root, 'src/server/ui', file), join(dist, 'ui', file));

console.log(`Built dist/ in ${Math.round(performance.now() - start)} ms`);
