import { readFile } from 'node:fs/promises';
import { expect, test } from './support/fixtures';
import { createVerifiedUser, E2E_PASSWORD } from './support/user';
import { addSubscriptionViaEditor } from './support/subscriptions';

/**
 * Data rights, end to end: export downloads a JSON that really contains the user's data, and
 * deletion — gated on the typed email confirmation and a fresh password re-auth — kills the
 * session and the credentials for good.
 */

test('export a JSON of my data, then delete the account and prove it is gone', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const user = await createVerifiedUser(page.request, testInfo, 'export');

  // Something worth exporting.
  await page.goto('/subscriptions');
  await addSubscriptionViaEditor(page, {
    name: 'Exportly',
    amount: '3.21',
    currency: 'USD',
    cadence: 'Monthly',
  });

  // ── export ─────────────────────────────────────────────────────────────────────────
  await page.goto('/settings');
  // The data panels render only once `me.current` resolves client-side; the email in the
  // danger-zone label is the signal the page is settled before anything is clicked.
  await expect(page.getByText(user.email).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Download JSON' }).click();

  // Export is a sensitive procedure; a fresh session owes a password confirmation first.
  const reauth = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(reauth).toBeVisible({ timeout: 60_000 });
  await reauth.getByLabel('Password').fill(E2E_PASSWORD);

  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await reauth.getByRole('button', { name: 'Confirm' }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/^ledger-export-\d{4}-\d{2}-\d{2}\.json$/u);
  const contents = await readFile(await download.path(), 'utf8');
  const parsed = JSON.parse(contents) as {
    profile: { email: string };
    subscriptions: readonly { displayName: string; amountMinor: number; currency: string }[];
  };

  expect(parsed.profile.email).toBe(user.email);
  expect(parsed.subscriptions).toHaveLength(1);
  expect(parsed.subscriptions[0]?.displayName).toBe('Exportly');
  expect(parsed.subscriptions[0]?.amountMinor).toBe(321);
  expect(parsed.subscriptions[0]?.currency).toBe('USD');

  await expect(page.getByText('Export downloaded.')).toBeVisible({ timeout: 20_000 });

  // ── delete, with the typed email confirmation ──────────────────────────────────────
  const confirmField = page.locator('#confirm-delete');
  await confirmField.fill(user.email);
  // Still inside the fifteen-minute re-auth window from the export, so this proceeds directly.
  await page.getByRole('button', { name: 'Delete my account' }).click();

  await page.waitForURL(/\/sign-in\?deleted=1/, { timeout: 60_000 });

  // The session is dead: every app route bounces to sign-in.
  await page.goto('/subscriptions');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fsubscriptions/, { timeout: 20_000 });

  // And the credentials no longer exist: signing in with them fails.
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('alert')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/sign-in/);
});
