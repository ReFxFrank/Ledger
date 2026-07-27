import { expect, test } from './support/fixtures';
import { createVerifiedUser, E2E_PASSWORD } from './support/user';

/**
 * The fixture connect path — the whole reason AGGREGATOR=fixture exists. Connecting is a
 * sensitive procedure, so the flow is: click → password re-auth dialog → the fixture session
 * completes inline (no hosted bank UI) → the 24-month backfill and detection run inside the
 * request → /review has candidates.
 *
 * The fixture plants 18 recurring series; the detector currently stands behind 20 pending
 * candidates for a fresh connect (some series surface more than one candidate — e.g. a price
 * rise splitting a cluster). The exact count is asserted because the corpus is seeded and
 * deterministic — if this number moves, detection behaviour moved, and that should fail loudly.
 */

const EXPECTED_CANDIDATES = 20;

const CADENCE_LABEL =
  /^(Weekly|Every 2 weeks|Every 4 weeks|Monthly|Quarterly|Every 6 months|Annually|Every \d+ (days|weeks|months|years))$/u;

test('connect the fixture bank, review the backfill, confirm one candidate with the keyboard', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await createVerifiedUser(page.request, testInfo, 'connect');

  // ── connect ────────────────────────────────────────────────────────────────────────
  await page.goto('/connections');
  await expect(page.getByText('No banks connected', { exact: false })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Connect a bank' }).first().click();

  // Connecting is gated on a fresh password confirmation. The dialog collects it and re-runs
  // the connect on success — the flow the user sees is click → password → import.
  const reauth = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(reauth).toBeVisible({ timeout: 15_000 });
  await reauth.getByLabel('Password').fill(E2E_PASSWORD);
  await reauth.getByRole('button', { name: 'Confirm' }).click();

  // The fixture session is `immediate`, so the same click carries on into the backfill. The
  // 24 months of history import and detection run inside this request — allow it time.
  await expect(page.getByText('Connected Fixture Bank.')).toBeVisible({ timeout: 240_000 });

  const summary = page.locator('section').filter({ hasText: 'Connected Fixture Bank.' });
  await expect(summary.locator('dd').nth(0)).toHaveText('2'); // the two fixture accounts
  const transactionsImported = Number(await summary.locator('dd').nth(1).innerText());
  expect(transactionsImported).toBeGreaterThan(500); // 24 months × 2 accounts of history
  await expect(summary.locator('dd').nth(2)).toHaveText(String(EXPECTED_CANDIDATES));

  // ── review ─────────────────────────────────────────────────────────────────────────
  await summary.getByRole('link', { name: /Review \d+ suggestions/u }).click();
  await page.waitForURL(/\/review/);

  const cards = page.locator('ul[aria-label="Detection suggestions"] > li');
  await expect(cards).toHaveCount(EXPECTED_CANDIDATES, { timeout: 30_000 });
  await expect(
    page.getByText(`${String(EXPECTED_CANDIDATES)} suggestions are waiting on you.`, {
      exact: false,
    }),
  ).toBeVisible();

  // ── the advertised keyboard path: J/K move, Y confirms ─────────────────────────────
  const articles = page.locator('ul[aria-label="Detection suggestions"] article');
  await articles.nth(0).locator('[id^="candidate-"]').click();
  await expect(articles.nth(0)).toBeFocused();

  await page.keyboard.press('j');
  await expect(articles.nth(1)).toBeFocused();
  await page.keyboard.press('k');
  await expect(articles.nth(0)).toBeFocused();

  const confirmedName = (await articles.nth(0).locator('[id^="candidate-"]').innerText()).trim();
  const confirmedCadence = (
    await articles.nth(0).locator('span').filter({ hasText: CADENCE_LABEL }).first().innerText()
  ).trim();
  expect(confirmedName).not.toBe('');
  expect(confirmedCadence).toMatch(CADENCE_LABEL);

  await page.keyboard.press('y');
  await expect(page.getByText(`${confirmedName} is now tracked.`)).toBeVisible({
    timeout: 20_000,
  });
  await expect(cards).toHaveCount(EXPECTED_CANDIDATES - 1, { timeout: 20_000 });

  // ── the confirmed candidate is a real subscription with the cadence the card claimed ─
  await page.goto('/subscriptions');
  const row = page
    .getByRole('grid', { name: 'Subscriptions' })
    .getByRole('row')
    .filter({ hasText: confirmedName });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByText(confirmedCadence, { exact: true })).toBeVisible();
});
