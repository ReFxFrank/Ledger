import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * These specs need a real Postgres and a real Redis — they exercise sign-up, 2FA, and the
 * detection pipeline, none of which mean anything against a mock. CI provides both as services;
 * locally, `docker compose up -d` does.
 *
 * `AGGREGATOR=fixture` is not a convenience here, it is the design: the FixtureAdapter serves a
 * deterministic 24-month history, so the bank-connection and review flows are testable end to
 * end without a Plaid sandbox account, a network call, or a flaky third party in the critical path.
 */
const PORT = Number(process.env['E2E_PORT'] ?? 3100);
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://localhost:${String(PORT)}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',

  // Every spec creates its own user, so there is no shared fixture to serialise against.
  fullyParallel: true,
  // Spread rather than assigned `undefined`: `exactOptionalPropertyTypes` treats an explicit
  // undefined as a value, and Playwright's own default (half the cores) is what we want locally.
  ...(process.env['CI'] === undefined ? {} : { workers: 2 }),

  // A retry in CI masks a flaky test as a passing one. One retry buys tolerance for genuine
  // infrastructure noise; more than that and the suite stops telling the truth.
  retries: process.env['CI'] === undefined ? 0 : 1,

  // `.only` is a lint error, but a `forbidOnly` build failure catches it if it ever lands.
  forbidOnly: process.env['CI'] !== undefined,

  timeout: 45_000,
  expect: { timeout: 10_000 },

  reporter:
    process.env['CI'] === undefined
      ? [['list']]
      : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // The app is dark-only by design; forcing the scheme keeps screenshots stable.
    colorScheme: 'dark',
    timezoneId: 'UTC',
    locale: 'en-US',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // 375px is the responsive floor the brief sets; a project rather than a per-test viewport
    // so a layout regression at that width fails the whole suite rather than one assertion.
    // The device descriptor defaults to WebKit; pinned to Chromium because CI installs only
    // Chromium and the point of this project is the viewport, not the engine.
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        viewport: { width: 375, height: 812 },
      },
    },
  ],

  webServer: {
    command: `pnpm start --port ${String(PORT)}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: process.env['CI'] === undefined,
    timeout: 120_000,
    env: {
      NODE_ENV: 'production',
      AGGREGATOR: 'fixture',
      LOG_LEVEL: 'warn',
      /**
       * `loadServerEnv` treats NODE_ENV=production as "deployed": it demands an https APP_URL,
       * a Resend key and VAPID keys. `next start` genuinely is production mode (anything else
       * serves the dev build), so those three are satisfied with values that are inert here:
       *
       *  - APP_URL is only read by server/auth.ts as a *fallback* for BETTER_AUTH_URL, which is
       *    set below to the origin the browser actually talks to. The https value never serves
       *    a request; it exists to pass the deployment check.
       *  - The Resend key is a syntactically-shaped dummy. The web app never sends email — the
       *    worker does, and the worker does not run under this suite.
       *  - Web push is never exercised by these specs; the VAPID pair just has to be present.
       *
       * BETTER_AUTH_URL must be this server's own origin: better-auth trusts only its baseURL,
       * and the root .env points at the dev server on :3000 — with that left in place every
       * auth POST from :3100 is rejected as cross-origin.
       */
      APP_URL: 'https://e2e.invalid',
      BETTER_AUTH_URL: BASE_URL,
      RESEND_API_KEY: 're_e2e_dummy_never_sends',
      VAPID_PUBLIC_KEY: 'e2e-dummy',
      VAPID_PRIVATE_KEY: 'e2e-dummy',
    },
  },
});
