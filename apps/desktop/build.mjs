/**
 * esbuild bundling for the Electron shell: TypeScript sources (plus the
 * workspace packages they import, which export raw .ts) are bundled into two
 * self-contained CommonJS files Electron loads directly:
 *
 *   src/main.ts    → dist/main.cjs     (main process; package.json "main")
 *   src/preload.ts → dist/preload.cjs  (contextBridge preload)
 *
 * 'electron' stays external — it is provided by the Electron runtime.
 * Paths are resolved from this file, so plain `node build.mjs` works from
 * any cwd (the build smoke test relies on that).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: false,
  external: ['electron'],
  logLevel: 'warning',
};

await build({
  ...shared,
  entryPoints: [path.join(root, 'src', 'main.ts')],
  outfile: path.join(root, 'dist', 'main.cjs'),
});

await build({
  ...shared,
  entryPoints: [path.join(root, 'src', 'preload.ts')],
  outfile: path.join(root, 'dist', 'preload.cjs'),
});

console.log('desktop build ok: dist/main.cjs + dist/preload.cjs');
