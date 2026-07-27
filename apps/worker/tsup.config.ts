import { defineConfig } from 'tsup';

/**
 * The workspace packages ship raw TypeScript — every `@ledger/*` package's `exports` field points
 * at `src/index.ts`, because `apps/web` transpiles them through Next and nothing else needed a
 * build step. tsup treats anything in `dependencies` as external by default, which would leave
 * `dist/index.js` importing `@ledger/db` and Node choking on a `.ts` file at runtime.
 *
 * So they are bundled in, and only real npm packages stay external. `pino` in particular must:
 * it resolves its pretty-print transport by module path in a worker thread, and a bundled copy
 * has no path to resolve.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  noExternal: [/^@ledger\//],
  banner: {
    // Bundling the workspace packages drags their CommonJS dependencies in with them — `plaid`
    // reaches `axios`, which reaches `form-data`, which calls `require('util')` at load. esbuild's
    // ESM output stubs `require` with a function that throws, so without a real one the process
    // dies on its first import. `createRequire` gives the stub something to find.
    js: "import { createRequire as __nodeCreateRequire } from 'node:module';\nconst require = __nodeCreateRequire(import.meta.url);",
  },
});
