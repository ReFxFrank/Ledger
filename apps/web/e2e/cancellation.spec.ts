import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { createVerifiedUser } from './support/user';
import { addSubscriptionViaEditor, openSubscriptionByKeyboard } from './support/subscriptions';

/**
 * The cancellation workflow: start it from a tracked subscription, walk the snapshotted
 * checklist, record the provider's confirmation reference, and check both the timeline and the
 * board reflect every step. Ledger cancels nothing itself — what is asserted here is the
 * record-keeping, which is the product.
 */

const REFERENCE = 'REF-E2E-000123';

/**
 * Whether the evidence object store is reachable. CI runs no MinIO, so the storage-dependent
 * check must skip *visibly* there rather than pass silently.
 */
async function storageReachable(request: APIRequestContext): Promise<boolean> {
  try {
    const response = await request.get('http://localhost:9000/minio/health/live', {
      timeout: 3_000,
    });
    return response.ok();
  } catch {
    return false;
  }
}

test('start a cancellation, walk the checklist, record the confirmation, see it on the board', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await createVerifiedUser(page.request, testInfo, 'cancel');

  // ── a subscription to get out of ───────────────────────────────────────────────────
  await page.goto('/subscriptions');
  await addSubscriptionViaEditor(page, {
    name: 'Streamflix Premium',
    amount: '15.99',
    currency: 'USD',
    cadence: 'Monthly',
  });
  await openSubscriptionByKeyboard(page, 'Streamflix Premium');

  // ── start ──────────────────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Start cancellation' }).click();
  await page.waitForURL(/\/cancellations\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const requestId = /\/cancellations\/([0-9a-f-]{36})$/.exec(new URL(page.url()).pathname)?.[1];
  expect(requestId).toBeDefined();

  await expect(page.getByText('In progress', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('What you do, in order.')).toBeVisible();

  // ── the checklist, step by step ────────────────────────────────────────────────────
  // A direct-billed subscription gets the generic account-settings playbook: five steps.
  const checklist = page
    .locator('ol')
    .filter({ has: page.getByText('Decline any retention offer', { exact: false }) });
  const steps = checklist.getByRole('checkbox');
  await expect(steps).toHaveCount(5);
  await expect(page.getByText('0/5')).toBeVisible();

  for (let index = 0; index < 5; index += 1) {
    await steps.nth(index).click();
    // Each tick is a mutation and an appended event; wait for the counter so the next click
    // cannot race a disabled checkbox.
    await expect(page.getByText(`${String(index + 1)}/5`)).toBeVisible({ timeout: 20_000 });
  }

  // ── record what the provider said ──────────────────────────────────────────────────
  await page.getByRole('button', { name: 'They confirmed it' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record what the provider said' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Reference number').fill(REFERENCE);
  await dialog.getByRole('button', { name: 'Record it' }).click();

  await expect(page.getByText('Confirmed by provider').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(REFERENCE)).toBeVisible();

  // ── the timeline holds the whole story, appended and never edited ──────────────────
  await expect(page.getByText('Cancellation started', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Checklist step updated').first()).toBeVisible();
  await expect(page.getByText('Confirmation received', { exact: false }).first()).toBeVisible();

  // ── the board shows the request in the confirmed column ────────────────────────────
  await page.goto('/cancellations');
  const card = page.locator(`a[href="/cancellations/${requestId ?? ''}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText('Streamflix Premium')).toBeVisible();

  // The innermost container holding both the column label and the card is the confirmed column.
  const confirmedColumn = page
    .locator('div')
    .filter({ hasText: 'Confirmed by provider' })
    .filter({ has: card })
    .last();
  await expect(confirmedColumn).toBeVisible();
});

test('evidence storage: uploads are not switched on, and the screen says so honestly', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);

  // CI runs no MinIO. Skip loudly — a silent pass here would claim coverage that does not exist.
  const reachable = await storageReachable(request);
  test.skip(
    !reachable,
    'MinIO is not reachable on localhost:9000 (S3_ENDPOINT) — the evidence-storage check cannot run. CI does not start MinIO, so this skip is expected there.',
  );

  await createVerifiedUser(page.request, testInfo, 'evidence');

  await page.goto('/subscriptions');
  await addSubscriptionViaEditor(page, {
    name: 'Evidencely',
    amount: '4.99',
    currency: 'USD',
    cadence: 'Monthly',
  });
  await openSubscriptionByKeyboard(page, 'Evidencely');
  await page.getByRole('button', { name: 'Start cancellation' }).click();
  await page.waitForURL(/\/cancellations\/[0-9a-f-]{36}$/, { timeout: 30_000 });

  /**
   * The storage is up, but this build deliberately ships no upload procedure — the evidence
   * panel must say so instead of rendering a drop zone that goes nowhere, and must offer the
   * one record it genuinely keeps (the confirmation reference). If somebody wires uploads in,
   * this test fails and should be rewritten to exercise the real upload against MinIO.
   */
  const evidence = page.locator('section, div').filter({
    has: page.getByText('Keep these. They are what a dispute turns on.'),
  });
  await expect(evidence.first()).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText('Attaching files is not switched on in this build', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record the reference' })).toBeVisible();
  expect(await page.locator('input[type="file"]').count()).toBe(0);
});
