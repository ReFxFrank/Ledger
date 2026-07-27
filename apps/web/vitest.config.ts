import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the server half of the app.
 *
 * The two aliases are the only reason this file exists: `~/*` is a tsconfig path Vite does not
 * read, and `server-only` is a Next bundler marker with no package behind it (see
 * `src/test/server-only.ts`). Without both, importing `appRouter` — which the cross-user access
 * suite has to do — fails at resolution rather than at assertion.
 */
export default defineConfig({
  resolve: {
    // Regex `find`s rather than the object form: a bare string alias only matches the exact
    // specifier or a `find/` prefix, and `~/server/...` needs the leading segment rewritten.
    alias: [
      { find: /^~\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) },
      {
        find: /^server-only$/,
        replacement: fileURLToPath(new URL('./src/test/server-only.ts', import.meta.url)),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Playwright owns `e2e/`; vitest picking those up would try to run a browser suite here.
    exclude: ['**/node_modules/**', '**/.next/**', 'e2e/**'],
  },
});
