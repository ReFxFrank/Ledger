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
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
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
    },
  },
});
