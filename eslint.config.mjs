// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import drizzle from 'eslint-plugin-drizzle';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

/**
 * Guardrails from the build brief §0.3 are encoded here rather than left to discipline:
 *  - no `any`, no `@ts-ignore`, no `console.log` in shipped code
 *  - no `.only` / `.skip` tests
 *  - `packages/detection` may not import node builtins, the DB, or anything network-shaped
 *  - `packages/crypto` is the only module allowed to touch raw key material
 */

const NODE_BUILTINS = [
  'fs',
  'node:fs',
  'node:fs/promises',
  'net',
  'node:net',
  'http',
  'node:http',
  'https',
  'node:https',
  'child_process',
  'node:child_process',
  'dns',
  'node:dns',
  'crypto',
  'node:crypto',
  'worker_threads',
  'node:worker_threads',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/storybook-static/**',
      '**/*.config.js',
      '**/drizzle/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, ...globals.es2023 },
    },
    plugins: { import: importPlugin },
    rules: {
      // --- brief §0.3 hard guardrails -------------------------------------------------
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-expect-error': 'allow-with-description', 'ts-nocheck': true },
      ],
      'no-console': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off', // too noisy with noUncheckedIndexedAccess
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false, allowNullish: false },
      ],

      // Silently swallowed errors are a §0.3 violation.
      'no-empty': ['error', { allowEmptyCatch: false }],

      // --- money safety ---------------------------------------------------------------
      // Monetary values are integers in minor units. Nothing may parseFloat them.
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is integer minor units. Use @ledger/core money helpers.' },
      ],

      // --- module hygiene ---------------------------------------------------------------
      'import/no-default-export': 'off',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@ledger/*/src/*', '@ledger/*/dist/*'],
              message: 'Import a package through its public entrypoint, not its internals.',
            },
          ],
        },
      ],
    },
  },

  // --- packages/detection must stay pure (brief §4, Phase 4 acceptance) ---------------
  {
    files: ['packages/detection/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...NODE_BUILTINS.map((name) => ({
              name,
              message:
                'packages/detection is a pure, offline package. No node builtins, no IO. See brief §4.',
            })),
            {
              name: '@ledger/db',
              message: 'packages/detection may not touch the database. It takes data in and returns data out.',
            },
            {
              name: '@ledger/banking',
              message: 'packages/detection may not depend on the aggregator layer.',
            },
          ],
          patterns: [
            {
              group: ['drizzle-orm', 'drizzle-orm/*', 'postgres', 'pg', 'ioredis', 'plaid', 'undici', 'axios'],
              message: 'packages/detection must have zero runtime dependencies beyond @ledger/core.',
            },
          ],
        },
      ],
    },
  },

  // --- drizzle safety: no unscoped deletes/updates -------------------------------------
  {
    files: ['packages/db/**/*.ts', 'apps/**/*.ts', 'packages/banking/**/*.ts', 'packages/notify/**/*.ts'],
    plugins: { drizzle },
    rules: {
      'drizzle/enforce-delete-with-where': ['error', { drizzleObjectName: ['db', 'tx'] }],
      'drizzle/enforce-update-with-where': ['error', { drizzleObjectName: ['db', 'tx'] }],
    },
  },

  // --- tests: no .only / no skipped tests, relaxed typing for fixtures -----------------
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/test/**/*.ts', '**/e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name=/^(describe|it|test|suite|bench)$/][property.name=/^(only|skip)$/]",
          message: 'No .only or .skip in committed tests (brief §0.3).',
        },
        {
          selector: "CallExpression[callee.name=/^(xit|xdescribe|fit|fdescribe)$/]",
          message: 'No focused or disabled tests in committed code (brief §0.3).',
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  // --- scripts and config may write to stdout ------------------------------------------
  {
    files: ['**/scripts/**/*.ts', '**/*.config.ts', '**/*.config.mjs', '**/seed/**/*.ts', '**/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // --- the logger package is the one place allowed to construct stdout writers ---------
  {
    files: ['packages/logger/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
