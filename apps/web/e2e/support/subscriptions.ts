import { type Page, expect } from '@playwright/test';

/**
 * Bulk row factory, through the tRPC endpoint the editor posts to.
 *
 * The editor path below is the right one when *the editor* is what is under test. It is the
 * wrong one when a spec needs twelve rows so the virtualiser has something to virtualise: that
 * is a minute of typing to set up a check that has nothing to do with typing, and a minute is
 * long enough that people start deleting the check.
 *
 * The body is superjson's wire shape (`{ json }`) because `init.ts` sets that transformer; a
 * bare input object is accepted by zod and then silently arrives as `undefined`.
 */
export async function seedSubscriptions(
  page: Page,
  baseURL: string,
  entries: readonly { readonly displayName: string; readonly amountMinor: number }[],
): Promise<void> {
  for (const entry of entries) {
    const response = await page.request.post(`${baseURL}/api/trpc/subscriptions.create`, {
      headers: { Origin: baseURL, 'content-type': 'application/json' },
      data: {
        json: {
          displayName: entry.displayName,
          amountMinor: entry.amountMinor,
          currency: 'USD',
          intervalUnit: 'month',
          intervalCount: 1,
          // Fixed rather than "today": the horizon window is 60 days, and an anchor that drifts
          // with the wall clock would put a tick inside or outside it depending on the date.
          anchorDate: '2026-01-08',
        },
      },
    });
    expect(
      response.ok(),
      `seeding ${entry.displayName} failed: ${String(response.status())} ${await response.text()}`,
    ).toBe(true);
  }
}

/**
 * Drives the subscription editor sheet end to end: open, fill, submit, wait for the toast.
 *
 * Shared by the subscriptions and cancellation specs, both of which need real rows created the
 * way a user creates them. Everything is located through the dialog so the toolbar's own
 * "Add subscription" button (same accessible name) can never be matched by mistake.
 */
export interface NewSubscription {
  readonly name: string;
  /** The decimal string a user would type, e.g. "12.99". */
  readonly amount: string;
  readonly currency: string;
  /** A preset label from INTERVAL_PRESETS, e.g. "Monthly" or "Annually". */
  readonly cadence:
    | 'Weekly'
    | 'Every 2 weeks'
    | 'Every 4 weeks'
    | 'Monthly'
    | 'Quarterly'
    | 'Every 6 months'
    | 'Annually';
}

export async function addSubscriptionViaEditor(page: Page, entry: NewSubscription): Promise<void> {
  /**
   * Wait for the table's initial load before touching the editor. The editor's post-create
   * invalidate can race the *first* list fetch: when the create resolves while that batched
   * request is still in flight, the invalidate folds into it and the pre-create (empty)
   * snapshot is what sticks — observed in this suite's traces under a parallel run, where the
   * server is busy enough for the automation to out-type the initial load. A user sees the
   * table before adding to it; the helper does the same.
   */
  await expect(
    page
      .getByText('Nothing tracked yet', { exact: false })
      .or(page.getByRole('grid', { name: 'Subscriptions' }))
      .first(),
  ).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Add subscription' }).first().click();

  const dialog = page.getByRole('dialog', { name: 'Add subscription' });
  await expect(dialog).toBeVisible();

  // Exact: the website field's placeholder ("https://netflix.com/account") also contains it.
  await dialog.getByPlaceholder('Netflix', { exact: true }).fill(entry.name);
  await dialog.getByPlaceholder('12.99').fill(entry.amount);
  // Filled explicitly every time: the field seeds from `me.current`, which may still be in
  // flight, and a GBP row in a USD account would silently drop out of the dashboard totals.
  await dialog.getByPlaceholder('GBP').fill(entry.currency);

  if (entry.cadence !== 'Monthly') {
    await dialog.getByRole('combobox', { name: 'Cadence' }).click();
    await page.getByRole('option', { name: entry.cadence, exact: true }).click();
  }

  await dialog.getByRole('button', { name: 'Add subscription' }).click();

  // The success toast carries the name; the dialog unmounts on success.
  await expect(page.getByText(`${entry.name} added.`)).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toBeHidden();

  // And the refetch the save triggered has landed — the next add (or navigation) starts from a
  // table that already shows this row, not from a refetch still in flight.
  await expect(
    page
      .getByRole('grid', { name: 'Subscriptions' })
      .getByRole('row')
      .filter({ hasText: entry.name }),
  ).toBeVisible({ timeout: 30_000 });
}

/**
 * Focuses a row in the subscriptions grid and opens its detail page with Enter — the advertised
 * keyboard path. Clicking the cadence cell (never the name button, whose Enter starts an inline
 * rename) puts DOM focus on the row; Enter then bubbles to the grid handler.
 */
export async function openSubscriptionByKeyboard(page: Page, name: string): Promise<string> {
  const grid = page.getByRole('grid', { name: 'Subscriptions' });
  const row = grid.getByRole('row').filter({ hasText: name });
  // Generous: under a parallel run the server may be mid-way through another worker's fixture
  // backfill, and the list refetch that follows the create can take a while to come back.
  await expect(row).toBeVisible({ timeout: 30_000 });

  await row.getByRole('gridcell').nth(3).click();
  await expect(row).toBeFocused();
  await page.keyboard.press('Enter');

  await page.waitForURL(/\/subscriptions\/[0-9a-f-]{36}$/);
  const match = /\/subscriptions\/([0-9a-f-]{36})$/.exec(new URL(page.url()).pathname);
  if (match?.[1] === undefined) throw new Error(`Not on a subscription detail page: ${page.url()}`);
  return match[1];
}
