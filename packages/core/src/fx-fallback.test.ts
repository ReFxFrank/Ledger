import { describe, expect, it } from 'vitest';
import { type CommitmentInput, aggregateCommitments } from './aggregate';
import { fallbackSnapshotFor, staticFallbackRates } from './fx-fallback';
import { convert } from './fx';
import { currency } from './currency';
import { money } from './money';
import { MONTHLY } from './interval';

const ASOF = '2026-07-27';

function sub(overrides: Partial<CommitmentInput> & { id: string }): CommitmentInput {
  return {
    amountMinor: 999,
    currency: 'USD',
    interval: MONTHLY,
    status: 'active',
    category: 'streaming_video',
    ...overrides,
  };
}

describe('fallbackSnapshotFor', () => {
  it('serves the snapshot in force on the requested date, and says which date it is from', () => {
    const snapshot = fallbackSnapshotFor(ASOF);
    expect(snapshot.asOf).toBe('2026-06-30');
    expect(snapshot.rates.length).toBeGreaterThan(0);
  });

  it('falls back to the earliest snapshot for a date before any snapshot existed', () => {
    // An indicative rate labelled with its date is still more honest than exclusion.
    expect(fallbackSnapshotFor('2020-01-01').asOf).toBe('2026-06-30');
  });
});

describe('staticFallbackRates', () => {
  it('covers the six majors against USD, both directions', () => {
    const table = staticFallbackRates(ASOF);
    for (const code of ['EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF'] as const) {
      expect(table.find(currency(code), currency('USD'), ASOF)).not.toBeNull();
      expect(table.find(currency('USD'), currency(code), ASOF)).not.toBeNull();
    }
  });

  it('respects minor-unit exponents when converting JPY', () => {
    const table = staticFallbackRates(ASOF);
    const rate = table.find(currency('JPY'), currency('USD'), ASOF);
    expect(rate).not.toBeNull();
    if (rate === null) throw new Error('unreachable');
    // ¥1,000 at 0.0065 is $6.50 — 650 US minor units, not 6 or 65,000. The exponent difference
    // (JPY has none, USD has two) is the factor-of-100 trap the fx module exists to avoid.
    expect(convert(money(1000, 'JPY'), rate).amountMinor).toBe(650);
  });

  it('has no cross rates: a non-USD pair stays unresolved rather than compounding roundings', () => {
    const table = staticFallbackRates(ASOF);
    expect(table.find(currency('EUR'), currency('GBP'), ASOF)).toBeNull();
  });
});

describe('aggregateCommitments with the fallback table', () => {
  const options = { displayCurrency: 'USD', rates: staticFallbackRates(ASOF), asOf: ASOF };

  /**
   * The property this module was built for: an EUR subscription is *in* the total — converted
   * at the indicative rate — and reported in `converted` so the UI can call it approximate.
   * The old behaviour (excluded, "not included in this total") understated the user's real
   * commitment, which for this product is the worse lie.
   */
  it('converts an EUR row into the total instead of excluding it, and lists it as approximate', () => {
    const totals = aggregateCommitments(
      [sub({ id: 'usd', amountMinor: 1000 }), sub({ id: 'eur', amountMinor: 1000, currency: 'EUR' })],
      options,
    );

    // €10.00 at 1.17 = $11.70.
    expect(totals.monthly.amountMinor).toBe(1000 + 1170);
    expect(totals.count).toBe(2);
    expect(totals.unconvertible).toEqual([]);
    expect(totals.converted).toEqual(['eur']);
  });

  it('still lands a currency outside the fallback table in unconvertible', () => {
    const totals = aggregateCommitments(
      [sub({ id: 'usd', amountMinor: 1000 }), sub({ id: 'sek', amountMinor: 1000, currency: 'SEK' })],
      options,
    );

    expect(totals.monthly.amountMinor).toBe(1000);
    expect(totals.unconvertible).toEqual(['sek']);
    expect(totals.converted).toEqual([]);
  });

  it('does not mark native display-currency rows as converted', () => {
    const totals = aggregateCommitments([sub({ id: 'usd', amountMinor: 1000 })], options);
    expect(totals.converted).toEqual([]);
  });
});
