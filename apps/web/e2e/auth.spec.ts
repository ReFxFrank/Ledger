import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { E2E_PASSWORD, freshTotpCode, uniqueEmail } from './support/user';

/**
 * The front door: sign-up, the mandatory TOTP enrolment, sign-out, and sign-in with both
 * factors. This is the one spec that drives enrolment through the real screens — the other
 * specs go through the auth API for speed, so if the screens break, this is the spec that says
 * so.
 */

/** Types a fresh six-digit code into the CodeInput row. Typing advances the boxes itself. */
async function typeTotpCode(page: Page, secret: string): Promise<void> {
  const code = await freshTotpCode(secret);
  await page.getByRole('textbox', { name: 'Digit 1 of 6' }).click();
  await page.keyboard.type(code, { delay: 50 });
}

test('signed-out visitors are redirected to /sign-in, carrying where they were going', async ({
  page,
}) => {
  await page.goto('/subscriptions');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fsubscriptions/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  await page.goto('/cancellations');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fcancellations/);

  // The root has no `next` to carry — it just lands on sign-in.
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('sign up → mandatory TOTP enrolment → app → sign out → sign back in with password + TOTP', async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);

  const email = uniqueEmail(testInfo, 'auth');
  const name = 'E2E Auth';

  // ── sign up ────────────────────────────────────────────────────────────────────────
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);

  const password = page.getByLabel('Password');
  await password.fill(E2E_PASSWORD);
  // The live length counter only moves once React has hydrated; a submit before that would hit
  // the pre-hydration POST fallback. If the first fill raced hydration, do it again.
  const counter = page.getByText(`(${String(E2E_PASSWORD.length)}/12)`);
  try {
    await expect(counter).toBeVisible({ timeout: 3_000 });
  } catch {
    await password.fill('');
    await password.fill(E2E_PASSWORD);
    await expect(counter).toBeVisible();
  }

  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/, { timeout: 20_000 });

  // ── enrolment, step 1: prove it is you ─────────────────────────────────────────────
  await expect(page.getByText('Secure the account.')).toBeVisible();
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Generate key' }).click();

  // ── step 2: read the secret off the screen, as a user with an authenticator would ──
  await expect(page.getByText('Setup key', { exact: true })).toBeVisible({ timeout: 15_000 });
  const groupedSecret = await page
    .getByText('Setup key', { exact: true })
    .locator('..')
    .locator('p')
    .nth(1)
    .innerText();
  const secret = groupedSecret.replace(/\s+/gu, '');
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

  /**
   * Both routes onto a phone are on screen: the QR for a camera, the key for typing. The QR is
   * rendered as inline SVG from the URI in this tab — asserting on `role="img"` rather than on an
   * `<img>` is the point, because an `<img>` would mean the secret went to somebody's server.
   */
  const qr = page.getByRole('img', { name: /QR code for your authenticator app/u });
  await expect(qr).toBeVisible();
  // One merged path of dark modules, drawn from a matrix — not an empty decorative frame.
  await expect(qr.locator('path')).toHaveCount(1);
  expect((await qr.locator('path').getAttribute('d'))?.length ?? 0).toBeGreaterThan(200);

  await page.getByLabel(/I have saved these backup codes/u).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  // ── step 3: prove the app works ────────────────────────────────────────────────────
  await typeTotpCode(page, secret);
  await expect(page.getByText('Two-factor is on.')).toBeVisible({ timeout: 15_000 });

  // Enrolment done: onboarding moves to step 2, and the rest is optional.
  await expect(page.getByText('Add what is charging you.')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Skip the rest and open the dashboard' }).click();
  await page.waitForURL(/\/$/, { timeout: 20_000 });
  await expect(page.getByText('Monthly commitment')).toBeVisible({ timeout: 20_000 });

  // ── sign out ───────────────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: `Account: ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL(/\/sign-in/, { timeout: 20_000 });

  // The session really is gone: app routes bounce straight back.
  await page.goto('/subscriptions');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fsubscriptions/);

  // ── sign back in: password, then the second factor ─────────────────────────────────
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.waitForURL(/\/sign-in\/two-factor/, { timeout: 20_000 });
  await typeTotpCode(page, secret);

  await page.waitForURL(/\/$/, { timeout: 20_000 });
  await expect(page.getByText('Monthly commitment')).toBeVisible({ timeout: 20_000 });
});
