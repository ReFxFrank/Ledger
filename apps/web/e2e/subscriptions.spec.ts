import { expect, test } from './support/fixtures';
import { createVerifiedUser } from './support/user';
import { addSubscriptionViaEditor, openSubscriptionByKeyboard } from './support/subscriptions';

/**
 * Manual subscriptions: five through the editor (one annual, one that gets split), the table,
 * the dashboard totals, and archiving.
 *
 * The expected totals are computed here in integer minor units, the same way the app computes
 * them (`monthlyEquivalent` / `annualEquivalent` in @ledger/core):
 *
 *   monthly rows:  1299 + 999 + 4550 + 800          = 7648
 *   annual row:    12000 → monthly 12000 × 1/12     = 1000 (exact)
 *   monthly total:                                    8648 → $86.48
 *
 *   annualized:    (1299 + 999 + 4550 + 800) × 12   = 91776
 *                  + 12000 × 1/1                    = 12000
 *   annual total:                                     103776 → $1,037.76
 *
 * Every amount is USD (the account's display currency), so no row can fall into the
 * "unconvertible" bucket and the totals must reconcile exactly.
 */

const ROWS = [
  { name: 'Streamly', amount: '12.99', currency: 'USD', cadence: 'Monthly' },
  { name: 'Musicly', amount: '9.99', currency: 'USD', cadence: 'Monthly' },
  { name: 'Newsly Annual', amount: '120.00', currency: 'USD', cadence: 'Annually' },
  { name: 'Gymly', amount: '45.50', currency: 'USD', cadence: 'Monthly' },
  { name: 'Cloudly', amount: '8.00', currency: 'USD', cadence: 'Monthly' },
] as const;

const EXPECTED_MONTHLY = '$86.48';
const EXPECTED_ANNUAL = '$1,037.76';

test('five manual subscriptions: table, totals, a split, and archiving', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await createVerifiedUser(page.request, testInfo, 'subs');

  // ── add five through the editor ────────────────────────────────────────────────────
  await page.goto('/subscriptions');
  await expect(page.getByText('Nothing tracked yet', { exact: false })).toBeVisible({
    timeout: 20_000,
  });
  // The empty state has its own differently-worded button; the toolbar appears with the rows.
  await page.getByRole('button', { name: 'Add a subscription' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();

  for (const row of ROWS) {
    await addSubscriptionViaEditor(page, row);
  }

  // ── the table shows all five ───────────────────────────────────────────────────────
  const grid = page.getByRole('grid', { name: 'Subscriptions' });
  for (const row of ROWS) {
    await expect(grid.getByRole('row').filter({ hasText: row.name })).toBeVisible();
  }
  await expect(page.getByText('5 tracked')).toBeVisible();
  // The annual row carries its cadence label.
  await expect(
    grid.getByRole('row').filter({ hasText: 'Newsly Annual' }).getByText('Annually'),
  ).toBeVisible();

  // ── split Cloudly with one other person ────────────────────────────────────────────
  await openSubscriptionByKeyboard(page, 'Cloudly');

  await page.getByRole('button', { name: 'Add person' }).first().click();
  await page.getByRole('button', { name: 'Add person' }).first().click();
  await page.getByLabel('Name for share 1').fill('Me');
  await page.getByLabel('Name for share 2').fill('Sam');
  await page.getByRole('button', { name: 'Split evenly' }).click();
  await expect(page.getByLabel('Amount for share 1')).toHaveValue('4.00');
  await expect(page.getByLabel('Amount for share 2')).toHaveValue('4.00');
  await page.getByRole('button', { name: 'Save split' }).click();
  await expect(page.getByText('Split saved.')).toBeVisible({ timeout: 15_000 });

  // ── the dashboard totals reconcile exactly with what was entered ───────────────────
  await page.goto('/');
  await expect(page.getByText('Monthly commitment')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(EXPECTED_MONTHLY)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(EXPECTED_ANNUAL)).toBeVisible();
  // No USD row may be excluded as unconvertible.
  await expect(page.getByText('not in these totals', { exact: false })).toBeHidden();

  // ── archive one from the keyboard and watch it leave the default view ──────────────
  await page.goto('/subscriptions');
  const gymly = page.getByRole('grid', { name: 'Subscriptions' }).getByRole('row').filter({
    hasText: 'Gymly',
  });
  await expect(gymly).toBeVisible({ timeout: 20_000 });
  await gymly.getByRole('gridcell').nth(3).click();
  await expect(gymly).toBeFocused();
  await page.keyboard.press('Space');

  await expect(page.getByText('1 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('1 archived.')).toBeVisible({ timeout: 15_000 });

  await expect(gymly).toBeHidden();
  await expect(page.getByText('4 tracked')).toBeVisible();

  // The archived toggle brings it back — archiving hides, it does not delete.
  await page.getByRole('switch', { name: 'Archived' }).click();
  await expect(
    page.getByRole('grid', { name: 'Subscriptions' }).getByRole('row').filter({ hasText: 'Gymly' }),
  ).toBeVisible({ timeout: 15_000 });
});
