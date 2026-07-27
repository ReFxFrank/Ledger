import { expect, test } from './support/fixtures';
import { createVerifiedUser, requireBaseURL, E2E_PASSWORD } from './support/user';
import { seedSubscriptions } from './support/subscriptions';
import { scan, walkFocusOrder } from './support/axe';

/**
 * The accessibility gate — brief Phase 9.
 *
 * Every authenticated screen, both auth screens, the dialogs, and the two states that matter
 * most for markup: **empty** and **populated**. They are genuinely different trees. An empty
 * subscriptions screen has no grid, no roving tabindex and no bulk bar; the populated one has
 * four hundred virtualised rows and every one of them is a `role="row"` that has to be right.
 * Scanning only one of them is how a suite claims coverage it does not have.
 *
 * Both Playwright projects run this file, so every screen is scanned at desktop *and* at 375px.
 * That is not redundancy: the mobile bar, the "More" menu and the responsive table are separate
 * DOM, and the reflow that produces them is exactly where a heading level or a landmark gets
 * lost.
 *
 * Nothing is excluded and no rule is disabled — see support/axe.ts for why. `serious` and
 * `critical` fail the run; `moderate` and `minor` are attached to the test as annotations so they
 * stay visible and actionable without turning the gate into noise.
 */

/* ────────────────────────────────────────────────────────────────────────────────────────
   The screens that need no data
   ──────────────────────────────────────────────────────────────────────────────────────── */

test('auth screens are clean, signed out', async ({ page }, testInfo) => {
  await page.goto('/sign-in');
  await scan(page, testInfo, '/sign-in', { ready: page.getByRole('button', { name: 'Sign in' }) });

  await page.goto('/sign-up');
  await scan(page, testInfo, '/sign-up', {
    ready: page.getByRole('button', { name: 'Create account' }),
  });

  // Reachable without a half-finished session: the form renders and refuses on submit, which is
  // the same tree a user sees between their password and their authenticator.
  await page.goto('/sign-in/two-factor');
  await scan(page, testInfo, '/sign-in/two-factor', {
    ready: page.getByRole('textbox', { name: 'Digit 1 of 6' }),
  });

  // A signed-out visitor asking for an app route lands here; it is a real screen with real copy.
  await page.goto('/nothing-is-here');
  await scan(page, testInfo, '/not-found', { ready: page.getByRole('link').first() });
});

test('every authenticated screen is clean with an empty account', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await createVerifiedUser(page.request, testInfo, 'a11y-empty');

  await page.goto('/');
  await scan(page, testInfo, '/ (empty)', { ready: page.getByText('Monthly commitment') });

  await page.goto('/subscriptions');
  await scan(page, testInfo, '/subscriptions (empty)', {
    ready: page.getByText('Nothing tracked yet', { exact: false }),
  });

  await page.goto('/review');
  await scan(page, testInfo, '/review (empty)', { ready: page.getByText('Nothing to review.') });

  await page.goto('/calendar');
  await scan(page, testInfo, '/calendar (empty)', { ready: page.getByText('Renewals') });

  await page.goto('/cancellations');
  await scan(page, testInfo, '/cancellations (empty)', {
    ready: page.getByText('Nothing on the board.'),
  });

  await page.goto('/analytics');
  await scan(page, testInfo, '/analytics (empty)', {
    ready: page.getByRole('heading', { name: 'Analytics' }),
  });

  await page.goto('/connections');
  await scan(page, testInfo, '/connections (empty)', {
    ready: page.getByText('No banks connected', { exact: false }),
  });

  await page.goto('/settings');
  await scan(page, testInfo, '/settings', { ready: page.getByText('Two-factor authentication') });

  await page.goto('/subscriptions/import');
  await scan(page, testInfo, '/subscriptions/import', {
    ready: page.getByRole('heading', { name: 'Subscriptions' }),
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────────
   The screens that only exist once there is data
   ──────────────────────────────────────────────────────────────────────────────────────── */

test('every screen is clean with real data behind it', async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  await createVerifiedUser(page.request, testInfo, 'a11y-full');

  // ── one fixture connect populates review, connections, analytics and the horizon ────
  await page.goto('/connections');
  await page.getByRole('button', { name: 'Connect a bank' }).first().click();
  const reauth = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(reauth).toBeVisible({ timeout: 15_000 });

  // The re-auth dialog is its own tree, and it is the one modal in the app that gates a
  // sensitive procedure — worth scanning before it is dismissed.
  await scan(page, testInfo, '/connections + re-auth dialog');

  await reauth.getByLabel('Password').fill(E2E_PASSWORD);
  await reauth.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Connected Fixture Bank.')).toBeVisible({ timeout: 300_000 });

  await scan(page, testInfo, '/connections (connected)');

  // ── review, with a queue in it ──────────────────────────────────────────────────────
  await page.goto('/review');
  const cards = page.locator('ul[aria-label="Detection suggestions"] > li');
  await scan(page, testInfo, '/review (populated)', { ready: cards.first() });

  // The expanded card exposes the evidence table — a different tree with its own headers.
  const articles = page.locator('ul[aria-label="Detection suggestions"] article');
  await articles.nth(0).locator('[id^="candidate-"]').click();
  await expect(articles.nth(0)).toBeFocused();
  await page.keyboard.press('Enter');
  await scan(page, testInfo, '/review + expanded evidence');

  // ── confirm two, so the table, the detail page and the totals have something in them ─
  await page.keyboard.press('y');
  await expect(page.getByText('is now tracked.', { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(articles.nth(0)).toBeFocused();
  await page.keyboard.press('y');
  await expect(cards).toHaveCount(18, { timeout: 30_000 });

  // ── the dashboard with a horizon, totals and an attention queue ──────────────────────
  await page.goto('/');
  await scan(page, testInfo, '/ (populated)', { ready: page.getByText('Monthly commitment') });

  // ── the virtualised table ───────────────────────────────────────────────────────────
  await page.goto('/subscriptions');
  const grid = page.getByRole('grid', { name: 'Subscriptions' });
  await scan(page, testInfo, '/subscriptions (populated)', { ready: grid });

  const firstRow = grid.getByRole('row').nth(1);
  const name = (await firstRow.getByRole('gridcell').first().innerText()).trim().split('\n')[0] ?? '';

  // ── the editor dialog, the app's densest form ───────────────────────────────────────
  await page.getByRole('button', { name: 'Add subscription' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Add subscription' })).toBeVisible();
  await scan(page, testInfo, '/subscriptions + editor dialog');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // ── detail ──────────────────────────────────────────────────────────────────────────
  await firstRow.getByRole('gridcell').nth(3).click();
  await expect(firstRow).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/subscriptions\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await scan(page, testInfo, '/subscriptions/[id]', {
    ready: page.getByRole('button', { name: 'Start cancellation' }),
  });

  // ── calendar and analytics, now with occurrences and 24 months of transactions ──────
  await page.goto('/calendar');
  await scan(page, testInfo, '/calendar (populated)', { ready: page.getByText('Renewals') });

  await page.goto('/analytics');
  await scan(page, testInfo, '/analytics (populated)', {
    ready: page.getByRole('heading', { name: 'Analytics' }),
  });

  // ── a cancellation in flight: the board, and the request with its playbook ──────────
  await page.goto('/subscriptions');
  await grid.getByRole('row').filter({ hasText: name }).first().getByRole('gridcell').nth(3).click();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/subscriptions\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Start cancellation' }).click();
  await page.waitForURL(/\/cancellations\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  await scan(page, testInfo, '/cancellations/[id]', {
    ready: page.getByText('What you do, in order.'),
  });

  await page.goto('/cancellations');
  await scan(page, testInfo, '/cancellations (populated)', {
    ready: page.getByText(name).first(),
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────────
   Focus, keyboard, and motion — the things axe cannot see
   ──────────────────────────────────────────────────────────────────────────────────────── */

test('every interactive element in the tab order shows a focus indicator', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await createVerifiedUser(page.request, testInfo, 'a11y-focus');

  for (const route of ['/', '/subscriptions', '/settings', '/connections', '/cancellations']) {
    await page.goto(route);
    // Settle: a control that mounts mid-walk shifts the tab order under the test.
    await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState('networkidle');

    const visited = await walkFocusOrder(page, 40);
    expect(visited.length, `nothing was focusable on ${route}`).toBeGreaterThan(3);

    const blind = visited.filter((entry) => !entry.indicator).map((entry) => entry.label);
    expect(
      blind,
      `${route}: focused with no visible indicator — something overrode --focus-ring:\n  ${blind.join('\n  ')}`,
    ).toEqual([]);
  }

  // The skip link is the first tab stop on every screen and is worthless if it is not.
  await page.goto('/');
  await expect(page.getByText('Monthly commitment')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#content')).toBeFocused();
});

test('dialogs trap focus while open and give it back when they close', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await createVerifiedUser(page.request, testInfo, 'a11y-dialog');

  await page.goto('/subscriptions');
  const trigger = page.getByRole('button', { name: 'Add a subscription' });
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: 'Add subscription' });
  await expect(dialog).toBeVisible();

  /**
   * A trap in the good sense: Tab must cycle *inside* the dialog and never reach the page behind
   * it. Twenty-five presses is comfortably more than the editor has controls, so if focus can
   * escape at all it escapes within the walk.
   */
  for (let index = 0; index < 25; index += 1) {
    await page.keyboard.press('Tab');
    const inside = await dialog.evaluate(
      (node) => document.activeElement !== null && node.contains(document.activeElement),
    );
    expect(inside, `Tab ${String(index + 1)} left the open dialog — focus is not trapped`).toBe(
      true,
    );
  }

  // Shift+Tab has to wrap the other way, which is the half that usually gets forgotten.
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press('Shift+Tab');
    const inside = await dialog.evaluate(
      (node) => document.activeElement !== null && node.contains(document.activeElement),
    );
    expect(inside, `Shift+Tab ${String(index + 1)} left the open dialog`).toBe(true);
  }

  // Escape closes it and focus returns to what opened it — not to <body>, where the next Tab
  // would start the whole page again.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('the virtualised subscriptions table is fully operable from the keyboard', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await createVerifiedUser(page.request, testInfo, 'a11y-grid');

  // Enough rows that the virtualiser is genuinely windowing: the claim under test is that a row
  // the DOM has not rendered yet is still reachable.
  await seedSubscriptions(
    page,
    requireBaseURL(testInfo),
    Array.from({ length: 12 }, (_unused, index) => ({
      displayName: `Keyboard ${String(index + 1).padStart(2, '0')}`,
      amountMinor: 999,
    })),
  );

  await page.goto('/subscriptions');
  const grid = page.getByRole('grid', { name: 'Subscriptions' });
  await expect(grid).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('12 tracked')).toBeVisible({ timeout: 30_000 });

  // ── the grid is one tab stop, and arrows move inside it ─────────────────────────────
  const rows = grid.getByRole('row');
  await rows.nth(1).getByRole('gridcell').nth(3).click();
  await expect(rows.nth(1)).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(2)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(rows.nth(1)).toBeFocused();

  // End jumps to the last row — which the virtualiser has not rendered. If keyboard operation is
  // real, the row scrolls into view and takes focus; if it is a claim, this is where it breaks.
  await page.keyboard.press('End');
  const last = grid.getByRole('row').filter({ hasText: 'Keyboard 12' });
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();

  await page.keyboard.press('Home');
  await expect(grid.getByRole('row').filter({ hasText: 'Keyboard 01' })).toBeFocused();

  // ── selection and the bulk bar, without a pointer ───────────────────────────────────
  await page.keyboard.press('Space');
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('2 selected')).toBeHidden();

  // ── the advertised search shortcut ──────────────────────────────────────────────────
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.keyboard.type('Keyboard 07');
  await expect(grid.getByRole('row').filter({ hasText: 'Keyboard 07' })).toBeVisible();
  await expect(grid.getByRole('row').filter({ hasText: 'Keyboard 01' })).toBeHidden();
  await page.keyboard.press('Escape');

  // ── and Enter opens the row it is on ────────────────────────────────────────────────
  await grid.getByRole('row').nth(1).getByRole('gridcell').nth(3).click();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/subscriptions\/[0-9a-f-]{36}$/, { timeout: 30_000 });
});

test('prefers-reduced-motion is honoured by the JS-driven entrance, not just by CSS', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await createVerifiedUser(page.request, testInfo, 'a11y-motion');

  /**
   * `tokens.css` collapses every CSS duration under the media query, but the Billing Horizon's
   * entrance is a `motion` stagger driven from JavaScript — a CSS rule cannot reach it. What is
   * asserted is the observable outcome rather than the implementation: with reduced motion on,
   * the bars are at their final geometry on the first frame after they mount.
   */
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // Something for the chart to draw.
  await seedSubscriptions(
    page,
    requireBaseURL(testInfo),
    Array.from({ length: 4 }, (_unused, index) => ({
      displayName: `Motion ${String(index)}`,
      amountMinor: 500 + index * 100,
    })),
  );

  await page.goto('/');
  const bars = page.locator('svg [data-horizon-tick]');
  await expect(bars.first()).toBeVisible({ timeout: 30_000 });

  // Read immediately — no waiting for an animation that must not be running.
  const scales = await bars.evaluateAll((nodes) =>
    nodes.map((node) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
      return { scaleY: matrix.d, opacity: Number(getComputedStyle(node).opacity) };
    }),
  );
  expect(scales.length).toBeGreaterThan(0);
  for (const [index, entry] of scales.entries()) {
    expect(entry.scaleY, `tick ${String(index)} is still scaling under reduced motion`).toBeCloseTo(
      1,
      2,
    );
    expect(entry.opacity, `tick ${String(index)} is still fading under reduced motion`).toBeCloseTo(
      1,
      2,
    );
  }

  // And with motion allowed the entrance still lands — a reduced-motion branch that broke the
  // animation for everybody would pass the check above.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await expect(bars.first()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () =>
        bars.first().evaluate((node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).d),
      { timeout: 5_000 },
    )
    .toBeCloseTo(1, 2);
});
