import type { NextConfig } from 'next';

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
