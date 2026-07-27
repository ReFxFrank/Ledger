import { expect, test } from './support/fixtures';
import { createVerifiedUser } from './support/user';
import { addSubscriptionViaEditor } from './support/subscriptions';

/**
 * The command palette and the global bindings.
 *
 * The half of this spec that matters most is the part that asserts nothing happened: a palette
 * that opens while someone is typing "k" into a search box is worse than no palette, and it is
 * the failure mode that survives manual testing, because the person testing it knows not to do
 * that. So the typing guard is checked first, before anything is proved to work at all.
 *
 * `MOD` is resolved from the host rather than hardcoded: the app binds ⌘ on Apple hardware and
 * Ctrl elsewhere, and CI runs on Linux while this was written on Windows.
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const SUBSCRIPTION = {
  name: 'Zephyrly',
  amount: '13.00',
  currency: 'USD',
  cadence: 'Monthly',
} as const;

test('the command palette: opens, filters, navigates, and stays out of the way', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await createVerifiedUser(page.request, testInfo, 'palette');

  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });

  await page.goto('/subscriptions');
  await addSubscriptionViaEditor(page, SUBSCRIPTION);

  // ── nothing fires while a text field has focus ─────────────────────────────────────
  const tableSearch = page.getByRole('searchbox', { name: 'Search subscriptions' });
  await tableSearch.click();
  await tableSearch.pressSequentially('k');
  await expect(tableSearch).toHaveValue('k');
  await expect(palette).toBeHidden();

  // Same for the go-to chord and the help key: "gd?" is three characters, not two commands.
  await tableSearch.pressSequentially('gd?');
  await expect(tableSearch).toHaveValue('kgd?');
  await expect(shortcuts).toBeHidden();
  await expect(page).toHaveURL(/\/subscriptions$/);

  await tableSearch.fill('');

  // ── ⌘K opens it from the keyboard, anywhere ────────────────────────────────────────
  // Focus off the field first: this asserts the binding works from the page, and the previous
  // block already proved it survives the field having focus.
  await page.getByRole('heading', { name: 'Everything charging you' }).click();
  await page.keyboard.press(`${MOD}+k`);
  await expect(palette).toBeVisible();

  const input = palette.getByRole('combobox');
  await expect(input).toBeFocused();

  // ── it filters down to a subscription of this user's ───────────────────────────────
  await input.pressSequentially(SUBSCRIPTION.name.slice(0, 6));

  const option = palette.getByRole('option', { name: new RegExp(SUBSCRIPTION.name) });
  await expect(option).toBeVisible({ timeout: 20_000 });
  // The row carries what it costs and how often, not just a name.
  await expect(option).toContainText('$13.00');
  await expect(option).toContainText('Monthly');

  // One match, announced as one, and pointed at by the combobox — the highlight a screen reader
  // follows is `aria-activedescendant`, not the CSS.
  await expect(palette.getByRole('status')).toHaveText('1 result');
  await expect(option).toHaveAttribute('aria-selected', 'true');
  const optionId = await option.getAttribute('id');
  await expect(input).toHaveAttribute('aria-activedescendant', String(optionId));

  // ── Enter opens it ─────────────────────────────────────────────────────────────────
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/subscriptions\/[0-9a-f-]{36}$/);
  await expect(palette).toBeHidden();
  await expect(page.getByRole('heading', { name: SUBSCRIPTION.name }).first()).toBeVisible({
    timeout: 20_000,
  });

  // ── Escape closes it and hands focus back to whatever opened it ────────────────────
  const trigger = page.getByRole('button', { name: /Search and commands, keyboard shortcut/ });
  await trigger.click();
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(trigger).toBeFocused();

  // ── `?` documents the rest of it, and `g s` is one of the bindings it documents ─────
  await page.keyboard.press('?');
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts.getByText('Open the command palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(shortcuts).toBeHidden();

  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await page.waitForURL(/\/subscriptions$/);
  await expect(page.getByRole('heading', { name: 'Everything charging you' })).toBeVisible({
    timeout: 20_000,
  });
});
