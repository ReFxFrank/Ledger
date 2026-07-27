/**
 * The demo dataset is an acceptance criterion, not decoration.
 *
 * Phase 1 asks for a specific list of hard cases — an annual plan with exactly two occurrences,
 * a trial converting in two days, a real price increase, one merchant on two cards — and the
 * point of these tests is that the list stays true. Someone tidying the fixture and quietly
 * dropping the duplicate makes the duplicate-detection screen untestable by hand, and nobody
 * notices for a week.
 *
 * There is no database here on purpose. `buildDemoDataset` is pure, so every one of these
 * assertions runs in milliseconds and none of them needs Postgres.
 */

import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  addMonths,
  daysBetween,
  formatPlainDate,
  isSameDate,
  occurrencesBetween,
  parsePlainDate,
  toInstant,
} from '@ledger/core';
import { buildDemoDataset } from './demo';
import type { DemoDataset, DemoSubscription } from './demo-data';

const REFERENCE = '2026-07-20';

function build(): DemoDataset {
  return buildDemoDataset({ clock: new FixedClock(toInstant(parsePlainDate(REFERENCE), 'UTC', 12)) });
}

function byName(dataset: DemoDataset, fragment: string): DemoSubscription {
  const found = dataset.subscriptions.filter((subscription) =>
    subscription.displayName.toLowerCase().includes(fragment.toLowerCase()),
  );
  const only = found[0];
  if (only === undefined) throw new Error(`No demo subscription matching ${JSON.stringify(fragment)}`);
  return only;
}

describe('the demo dataset', () => {
  it('is deterministic', () => {
    // Same clock in, byte-identical fixture out. If this fails, something reached for
    // Math.random or an ambient Date and the seed stopped being reproducible.
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it('anchors everything to the reference date it was given', () => {
    const dataset = build();
    expect(formatPlainDate(dataset.referenceDate)).toBe(REFERENCE);
  });

  it('has 20 subscriptions across 3 currencies', () => {
    const dataset = build();
    expect(dataset.subscriptions).toHaveLength(20);
    expect(new Set(dataset.subscriptions.map((s) => s.currency))).toEqual(
      new Set(['USD', 'GBP', 'EUR']),
    );
  });

  it('has 2 payment methods, and every subscription is on one of them', () => {
    const dataset = build();
    expect(dataset.paymentMethods).toHaveLength(2);

    const known = new Set(dataset.paymentMethods.map((method) => method.id));
    for (const subscription of dataset.subscriptions) {
      expect(known.has(subscription.paymentMethodId)).toBe(true);
    }
  });

  it('gives every row a distinct, stable id', () => {
    const dataset = build();
    const ids = dataset.subscriptions.map((subscription) => subscription.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Second build, same ids — this is what makes the seed idempotent rather than additive.
    expect(build().subscriptions.map((subscription) => subscription.id)).toEqual(ids);
  });

  it('keeps every amount an integer count of minor units', () => {
    for (const subscription of build().subscriptions) {
      expect(Number.isInteger(subscription.amountMinor)).toBe(true);
      expect(subscription.amountMinor).toBeGreaterThan(0);
    }
  });

  // ── the specified hard cases ────────────────────────────────────────────────────────

  it('includes an annual plan bought 14 months ago, so it has exactly two occurrences', () => {
    const dataset = build();
    const annual = byName(dataset, 'Adobe');

    expect(annual.interval).toEqual({ unit: 'year', count: 1 });

    const anchor = parsePlainDate(annual.anchorDate);
    expect(isSameDate(anchor, addMonths(dataset.referenceDate, -14))).toBe(true);

    const charged = occurrencesBetween(anchor, annual.interval, anchor, dataset.referenceDate);
    expect(charged).toHaveLength(2);

    // And the next one is still ahead, which is what makes it show on the horizon.
    expect(annual.nextRenewalAt).not.toBeNull();
  });

  it('includes a trial that converts in 2 days', () => {
    const dataset = build();
    const trial = dataset.subscriptions.filter((s) => s.status === 'trialing');
    expect(trial).toHaveLength(1);

    const only = trial[0];
    if (only === undefined) throw new Error('unreachable');
    expect(only.trialEndsAt).not.toBeNull();

    const endsOn = parsePlainDate(only.anchorDate);
    expect(daysBetween(dataset.referenceDate, endsOn)).toBe(2);
    // The `trial_ending` alert defaults to 3 days' lead time, so two days out means the alert
    // is already due — which is the whole reason this row exists.
    expect(dataset.notificationPreferences.find((p) => p.type === 'trial_ending')?.leadTimeDays).toBe(3);
  });

  it('includes a price-increased subscription with real price-history rows', () => {
    const dataset = build();
    const increased = dataset.subscriptions.filter((s) => s.priceHistory.length > 0);
    expect(increased).toHaveLength(1);

    const only = increased[0];
    if (only === undefined) throw new Error('unreachable');
    expect(only.priceHistory.length).toBeGreaterThanOrEqual(2);

    const [first, ...rest] = only.priceHistory;
    expect(first?.deltaBps).toBeNull();

    for (const row of rest) {
      // Brief §4.4: a history row is written when the amount moves by ≥3%, i.e. 300 bps.
      expect(row.deltaBps).not.toBeNull();
      expect(row.deltaBps ?? 0).toBeGreaterThanOrEqual(300);
    }

    // The newest history row is the amount the subscription actually carries.
    const latest = only.priceHistory[only.priceHistory.length - 1];
    expect(latest?.amountMinor).toBe(only.amountMinor);
  });

  it('includes a duplicate: one merchant billing two different cards', () => {
    const dataset = build();

    const byMerchant = new Map<string, DemoSubscription[]>();
    for (const subscription of dataset.subscriptions) {
      if (subscription.merchantSlug === null) continue;
      const bucket = byMerchant.get(subscription.merchantSlug) ?? [];
      bucket.push(subscription);
      byMerchant.set(subscription.merchantSlug, bucket);
    }

    const duplicates = [...byMerchant.values()].filter((bucket) => bucket.length > 1);
    expect(duplicates).toHaveLength(1);

    const pair = duplicates[0] ?? [];
    expect(pair).toHaveLength(2);
    expect(new Set(pair.map((subscription) => subscription.paymentMethodId)).size).toBe(2);
  });

  it('includes a paused subscription', () => {
    expect(build().subscriptions.filter((s) => s.status === 'paused')).toHaveLength(1);
  });

  it('includes a variable-amount subscription', () => {
    expect(build().subscriptions.filter((s) => s.variableAmount).length).toBeGreaterThanOrEqual(1);
  });

  it('includes a shared subscription whose shares add up to the charge', () => {
    const dataset = build();
    const shared = dataset.subscriptions.filter((s) => s.shares.length > 0);
    expect(shared).toHaveLength(1);

    const only = shared[0];
    if (only === undefined) throw new Error('unreachable');

    const total = only.shares.reduce((sum, share) => sum + share.shareMinor, 0);
    // Not "close enough": an allocation that loses a minor unit is a rounding bug on screen.
    expect(total).toBe(only.amountMinor);
    expect(only.shares.filter((share) => share.isSelf)).toHaveLength(1);
  });

  it('includes a cancelled-and-verified subscription, so reclaimed savings are non-zero', () => {
    const dataset = build();

    const verified = dataset.cancellations.filter((request) => request.status === 'verified');
    expect(verified).toHaveLength(1);

    const request = verified[0];
    if (request === undefined) throw new Error('unreachable');
    expect(request.verifiedAt).not.toBeNull();

    const subscription = dataset.subscriptions.find((s) => s.id === request.subscriptionId);
    expect(subscription?.status).toBe('canceled');
    // The reclaimed counter reads the subscription's amount, so a zero here would make the one
    // number in the product allowed to be green read zero.
    expect(subscription?.amountMinor ?? 0).toBeGreaterThan(0);
  });

  it('leaves an open cancellation so the board is not an empty state', () => {
    const dataset = build();
    const open = dataset.cancellations.filter((request) => request.status === 'in_progress');
    expect(open).toHaveLength(1);
    expect(open[0]?.resolvedAt).toBeNull();
  });

  it('points every cancellation at a subscription it actually seeded', () => {
    const dataset = build();
    const ids = new Set(dataset.subscriptions.map((subscription) => subscription.id));
    for (const request of dataset.cancellations) {
      expect(ids.has(request.subscriptionId)).toBe(true);
    }
  });

  // ── credentials ─────────────────────────────────────────────────────────────────────

  it('mints a usable TOTP secret and prints-able credentials', () => {
    const { credentials } = build();

    expect(credentials.totpSecret).toHaveLength(32);
    // Base32, unpadded — what an authenticator app will accept.
    expect(credentials.totpSecretBase32).toMatch(/^[A-Z2-7]+$/);
    expect(credentials.totpUri.startsWith('otpauth://totp/')).toBe(true);
    expect(credentials.totpUri).toContain(`secret=${credentials.totpSecretBase32}`);

    // better-auth's node scrypt format: hex salt, colon, hex key.
    expect(credentials.passwordHash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(credentials.password.length).toBeGreaterThanOrEqual(12);
    expect(credentials.backupCodes).toHaveLength(10);
  });

  it('mints the same credentials on every run', () => {
    expect(build().credentials).toEqual(build().credentials);
  });
});
