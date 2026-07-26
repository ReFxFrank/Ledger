import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

/**
 * Configuration lives in a single `.env` at the monorepo root (README, "cp .env.example .env"),
 * but Next only looks in the app directory. Without this, `loadServerEnv()` — which runs at
 * module scope in `src/server/auth.ts` and `src/server/trpc/init.ts` — throws during both
 * `next dev` and the page-data collection pass of `next build`.
 *
 * `loadEnvConfig` is the same loader Next uses internally, so precedence (`.env.local` over
 * `.env`, `NODE_ENV`-specific files) matches what the framework does for the app directory.
 * Values already present in the real environment win, which keeps deployed builds authoritative.
 *
 * `forceReload` is required: Next runs its own `loadEnvConfig` against `apps/web` before it
 * evaluates this file, and the loader is a no-op on every subsequent call unless forced.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
loadEnvConfig(repoRoot, process.env['NODE_ENV'] !== 'production', undefined, true);

/**
 * Workspace packages are consumed as TypeScript source rather than built to `dist` first.
 * It costs a little build time and removes a whole class of stale-artifact bugs from the
 * inner loop — see docs/PROGRESS.md, open decision #10.
 */
const WORKSPACE_PACKAGES = [
  '@ledger/core',
  '@ledger/crypto',
  '@ledger/db',
  '@ledger/detection',
  '@ledger/env',
  '@ledger/logger',
  '@ledger/notify',
  '@ledger/providers',
  '@ledger/ui',
  '@ledger/banking',
];

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: WORKSPACE_PACKAGES,
  poweredByHeader: false,

  experimental: {
    // Keeps `pino`, `postgres`, and the crypto module out of the client graph entirely rather
    // than relying on tree-shaking to notice they are server-only.
    serverActions: { bodySizeLimit: '4mb' },
  },

  serverExternalPackages: ['pino', 'pino-pretty', 'postgres', 'ioredis', 'better-auth'],

  /**
   * Headers that do not depend on a per-request nonce. The CSP itself is set in middleware,
   * because `unsafe-inline` is forbidden (brief §9.9) and that means a fresh nonce per response.
   */
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          // The app is a map of someone's finances; it has no business in a search index.
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ]);
  },
};

export default config;
