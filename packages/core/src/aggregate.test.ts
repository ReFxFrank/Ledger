import { describe, expect, it } from 'vitest';
import {
  type CommitmentInput,
  aggregateByCategory,
  aggregateCommitments,
  simulateCancellations,
} from './aggregate';
import { fxRate, staticRateTable } from './fx';
import { ANNUAL, FOUR_WEEKLY, MONTHLY, QUARTERLY, WEEKLY } from './interval';
import { UnsupportedCurrencyError } from './errors';

const ASOF = '2026-07-25';
const NO_RATES = staticRateTable([]);
const RATES = staticRateTable([
  fxRate('GBP', 'USD', '1.27', ASOF),
  fxRate('EUR', 'USD', '1.08', ASOF),
]);

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

describe('aggregateCommitments', () => {
  it('totals monthly and annual for a single monthly subscription', () => {
    const totals = aggregateCommitments([sub({ id: 'a', amountMinor: 999 })], {
      displayCurrency: 'USD',
      rates: NO_RATES,
      asOf: ASOF,
    });

    expect(totals.monthly.amountMinor).toBe(999);
    expect(totals.annual.amountMinor).toBe(11_988);
    expect(totals.count).toBe(1);
    expect(totals.unconvertible).toEqual([]);
  });

  /**
   * The regression this module's one real bug produced. `'usd'` used to be cast rather than
   * validated, so every row failed the currency comparison, fell into `unconvertible`, and the
   * dashboard reported zero committed spend without raising anything.
   */
  it('normalizes a lowercase display currency instead of silently zeroing every total', () => {
    const rows = [sub({ id: 'a', amountMinor: 1500 }), sub({ id: 'b', amountMinor: 2500 })];

    const upper = aggregateCommitments(rows, { displayCurrency: 'USD', rates: NO_RATES, asOf: ASOF });
    const lower = aggregateCommitments(rows, { displayCurrency: 'usd', rates: NO_RATES, asOf: ASOF });

    expect(lower.monthly.amountMinor).toBe(4000);
    expect(lower.unconvertible).toEqual([]);
    expect(lower).toEqual(upper);
  });

  it('rejects a display currency that is not a real ISO-4217 code', () => {
    expect(() =>
      aggregateCommitments([sub({ id: 'a' })], {
        displayCurrency: 'XYZ',
        rates: NO_RATES,
        asOf: ASOF,
      }),
    ).toThrow(UnsupportedCurrencyError);
  });

  it('counts four-weekly as thirteen charges a year, not twelve', () => {
    const monthly = aggregateCommitments([sub({ id: 'm', amountMinor: 899, interval: MONTHLY })], {
      displayCurrency: 'USD',
      rates: NO_RATES,
      asOf: ASOF,
    });
    const fourWeekly = aggregateCommitments(
      [sub({ id: 'f', amountMinor: 899, interval: FOUR_WEEKLY })],
      { displayCurrency: 'USD', rates: NO_RATES, asOf: ASOF },
    );

    // 899 × 365/28 = 11,719.10… → 11,719. The monthly equivalent is 899 × 12 = 10,788.
    // That 931-minor-unit gap is a whole extra charge a year the user would not have been shown.
    expect(monthly.annual.amountMinor).toBe(10_788);
    expect(fourWeekly.annual.amountMinor).toBe(11_719);
    expect(fourWeekly.annual.amountMinor).toBeGreaterThan(monthly.annual.amountMinor);
  });

  it('handles weekly, quarterly, and annual cadences in one portfolio', () => {
    const totals = aggregateCommitments(
      [
        sub({ id: 'w', amountMinor: 500, interval: WEEKLY }),
        sub({ id: 'q', amountMinor: 3000, interval: QUARTERLY }),
        sub({ id: 'y', amountMinor: 12_000, interval: ANNUAL }),
      ],
      { displayCurrency: 'USD', rates: NO_RATES, asOf: ASOF },
    );

    // weekly 500 × 365/7 = 26,071.43 → 26,071 ; quarterly 3000 × 4 = 12,000 ; annual 12,000
    expect(totals.annual.amountMinor).toBe(26_071 + 12_000 + 12_000);
    expect(totals.count).toBe(3);
  });

  it('excludes statuses that no longer cost money', () => {
    const totals = aggregateCommitments(
      [
        sub({ id: 'a', status: 'active', amountMinor: 1000 }),
        sub({ id: 't', status: 'trialing', amountMinor: 1000 }),
        sub({ id: 'c', status: 'cancel_scheduled', amountMinor: 1000 }),
        sub({ id: 'x', status: 'canceled', amountMinor: 1000 }),
        sub({ id: 'l', status: 'lapsed', amountMinor: 1000 }),
        sub({ id: 'p', status: 'paused', amountMinor: 1000 }),
      ],
      { displayCurrency: 'USD', rates: NO_RATES, asOf: ASOF },
    );

    expect(totals.count).toBe(3);
    expect(totals.monthly.amountMinor).toBe(3000);
  });

  it('converts foreign currencies when a rate exists', () => {
    const totals = aggregateCommitments(
      [
        sub({ id: 'usd', amountMinor: 1000, currency: 'USD' }),
        sub({ id: 'gbp', amountMinor: 1000, currency: 'GBP' }),
      ],
      { displayCurrency: 'USD', rates: RATES, asOf: ASOF },
    );

    expect(totals.monthly.amountMinor).toBe(1000 + 1270);
    expect(totals.unconvertible).toEqual([]);
  });

  /**
   * A total that quietly omits a subscription is worse than one that says so — the user has no
   * way to notice the difference between "you spend $200" and "you spend $200 plus something we
   * couldn't price".
   */
  it('reports rows it could not convert rather than dropping or coercing them', () => {
    const totals = aggregateCommitments(
      [
        sub({ id: 'usd', amountMinor: 1000, currency: 'USD' }),
        sub({ id: 'jpy', amountMinor: 1000, currency: 'JPY' }),
      ],
      { displayCurrency: 'USD', rates: RATES, asOf: ASOF },
    );

    expect(totals.monthly.amountMinor).toBe(1000);
    expect(totals.unconvertible).toEqual(['jpy']);
    expect(totals.count).toBe(1);
  });

  it('separates the user personal share from the full charge', () => {
    const totals = aggregateCommitments(
      [sub({ id: 'family', amountMinor: 1999, selfShareMinor: 500 })],
      { displayCurrency: 'USD', rates: NO_RATES, asOf: ASOF },
    );

    expect(totals.monthly.amountMinor).toBe(1999);
    expect(totals.monthlySelf.amountMinor).toBe(500);
  });

  it('returns a zero total in the display currency for an empty portfolio', () => {
    const totals = aggregateCommitments([], { displayCurrency: 'EUR', rates: NO_RATES, asOf: ASOF });
    expect(totals.monthly.amountMinor).toBe(0);
    expect(totals.monthly.currency).toBe('EUR');
    expect(totals.count).toBe(0);
  });

  it('honours a custom status filter', () => {
    const totals = aggregateCommitments(
      [sub({ id: 'a', status: 'canceled', amountMinor: 700 })],
      {
        displayCurrency: 'USD',
        rates: NO_RATES,
        asOf: ASOF,
        includeStatus: (status) => status === 'canceled',
      },
    );
    expect(totals.monthly.amountMinor).toBe(700);
  });
});

describe('aggregateByCategory', () => {
  it('buckets by category and orders by annual spend descending', () => {
    const buckets = aggregateByCategory(
      [
        sub({ id: 'a', category: 'streaming_video', amountMinor: 500 }),
        sub({ id: 'b', category: 'streaming_video', amountMinor: 500 }),
        sub({ id: 'c', category: 'gaming', amountMinor: 2000 }),
        sub({ id: 'd', category: 'ai', amountMinor: 100 }),
      ],
      { displayCurrency: 'USD', rates: NO_RATES, asOf: ASOF },
    );

    expect(buckets.map((b) => b.category)).toEqual(['gaming', 'streaming_video', 'ai']);
    expect(buckets[0]?.monthly.amountMinor).toBe(2000);
    expect(buckets[1]?.count).toBe(2);
  });

  it('reconciles: the category totals sum back to the portfolio total', () => {
    const rows = [
      sub({ id: 'a', category: 'streaming_video', amountMinor: 1099, interval: MONTHLY }),
      sub({ id: 'b', category: 'gaming', amountMinor: 5999, interval: QUARTERLY }),
      sub({ id: 'c', category: 'ai', amountMinor: 20_000, interval: ANNUAL }),
      sub({ id: 'd', category: 'fitness', amountMinor: 799, interval: WEEKLY }),
    ];
    const options = { displayCurrency: 'USD', rates: NO_RATES, asOf: ASOF };

    const portfolio = aggregateCommitments(rows, options);
    const byCategory = aggregateByCategory(rows, options);
    const summed = byCategory.reduce((total, bucket) => total + bucket.annual.amountMinor, 0);

    expect(summed).toBe(portfolio.annual.amountMinor);
  });
});

describe('simulateCancellations', () => {
  it('reports what cancelling a set would reclaim, monthly and annually', () => {
    const rows = [
      sub({ id: 'keep', amountMinor: 1000, interval: MONTHLY }),
      sub({ id: 'drop', amountMinor: 1500, interval: MONTHLY }),
      sub({ id: 'drop-annual', amountMinor: 12_000, interval: ANNUAL }),
    ];

    const result = simulateCancellations(rows, ['drop', 'drop-annual'], {
      displayCurrency: 'USD',
      rates: NO_RATES,
      asOf: ASOF,
    });

    expect(result.before.monthly.amountMinor).toBe(1000 + 1500 + 1000);
    expect(result.after.monthly.amountMinor).toBe(1000);
    expect(result.reclaimedMonthly.amountMinor).toBe(2500);
    expect(result.reclaimedAnnual.amountMinor).toBe(1500 * 12 + 12_000);
  });

  it('reclaims nothing when nothing is selected', () => {
    const rows = [sub({ id: 'a', amountMinor: 1000 })];
    const result = simulateCancellations(rows, [], {
      displayCurrency: 'USD',
      rates: NO_RATES,
      asOf: ASOF,
    });

    expect(result.reclaimedMonthly.amountMinor).toBe(0);
    expect(result.after).toEqual(result.before);
  });

  it('ignores ids that are not in the portfolio', () => {
    const rows = [sub({ id: 'a', amountMinor: 1000 })];
    const result = simulateCancellations(rows, ['not-here'], {
      displayCurrency: 'USD',
      rates: NO_RATES,
      asOf: ASOF,
    });

    expect(result.reclaimedAnnual.amountMinor).toBe(0);
  });
});
