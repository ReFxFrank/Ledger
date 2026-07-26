import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // Brief §11: money and date math are 100%. Nothing here is allowed to be untested.
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 95,
        statements: 100,
      },
    },
  },
});
