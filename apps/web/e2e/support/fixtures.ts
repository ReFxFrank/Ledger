import { createHash } from 'node:crypto';
import { test as base } from '@playwright/test';

/**
 * Per-test client IP.
 *
 * better-auth rate-limits per IP in production mode — which is what the suite runs against —
 * and every parallel worker otherwise arrives from 127.0.0.1, so a full parallel run trips the
 * limiter and fails with 429s that have nothing to do with the app under test. Disabling the
 * limiter would mean the suite tests a different auth stack than production runs, so instead
 * each test presents its own address: one test is one user on one device, which is exactly the
 * traffic shape the limiter is calibrated for.
 */
function ipFor(seed: string): string {
  const hash = createHash('sha256').update(seed, 'utf8').digest();
  return `10.${String(hash[0] ?? 0)}.${String(hash[1] ?? 0)}.${String(hash[2] ?? 0)}`;
}

// The wall clock salts the address so a retry — or the same test re-run seconds later — does
// not inherit the rate-limit bucket its previous attempt just spent. (Date.now in test tooling
// is fine; the ban is on shipped logic.)
const bootStamp = Date.now();

export const test = base.extend({
  // Overrides the built-in `extraHTTPHeaders` context option with a per-test value.
  extraHTTPHeaders: async ({ browserName: _browserName }, use, testInfo) => {
    await use({ 'x-forwarded-for': ipFor(`${testInfo.testId}:${String(bootStamp)}`) });
  },
});

export { expect } from '@playwright/test';
