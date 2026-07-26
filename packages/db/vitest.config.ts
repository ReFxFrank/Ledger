import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/state/**/*.ts', 'src/scope.ts'],
      exclude: ['src/**/*.test.ts'],
      // Brief Phase 1 acceptance: the state machine has 100% branch coverage.
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
