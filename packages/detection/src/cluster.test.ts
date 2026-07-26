/**
 * Clustering mechanics.
 *
 * The assertions here are about the three things that make a cluster trustworthy before cadence
 * runs: what belongs in it, what its price is, and which charges are evidence of nothing.
 */

import { formatPlainDate, parsePlainDate } from '@ledger/core';
import { describe, expect, it } from 'vitest';

import { amountBand, clusterTransactions, coefficientOfVariation, integerMedian } from './cluster';
import type { DetectionTransaction } from './types';

const on = (iso: string) => parsePlainDate(iso);

interface Row {
  readonly at: string;
  readonly amount: number;
  readonly descriptor?: string;
  readonly currency?: string;
  readonly account?: string;
  readonly pending?: boolean;
}

function build(rows: readonly Row[]): DetectionTransaction[] {
  return rows.map((row, index) => ({
    id: `t${String(index + 1).padStart(3, '0')}`,
    postedAt: on(row.at),
    amountMinor: row.amount,
    currency: row.currency ?? 'USD',
    rawDescriptor: row.descriptor ?? 'NETFLIX.COM',
    accountId: row.account ?? 'acct-1',
    pending: row.pending ?? false,
  }));
}

/** Monthly rows on the 15th, at a given sequence of amounts. */
function monthly(amounts: readonly number[], overrides: Omit<Row, 'at' | 'amount'> = {}): Row[] {
  return amounts.map((amount, index) => ({
    at: `2026-${String(index + 1).padStart(2, '0')}-15`,
    amount,
    ...overrides,
  }));
}

describe('integerMedian', () => {
  it('takes the middle of an odd-length set', () => {
    expect(integerMedian([300, 100, 200])).toBe(200);
  });

  it('rounds an even-length median down rather than inventing a fractional price', () => {
    // 9.99 and 12.99 average to 11.49, and £11.495 is not a price anybody was charged. Rounding
    // down is the conservative direction: it can never overstate committed spend.
    expect(integerMedian([999, 1299])).toBe(1149);
    expect(integerMedian([100, 101])).toBe(100);
  });

  it('is zero for an empty set rather than NaN', () => {
    expect(integerMedian([])).toBe(0);
  });
});

describe('amountBand', () => {
  it('is 2% of the median once that exceeds the absolute floor', () => {
    expect(amountBand(10_000, 200)).toBe(200);
  });

  it('holds a floor so cheap subscriptions stay clusterable', () => {
    // 2% of £0.99 is two pence, and no billing system with tax and FX rounding is that precise.
    expect(amountBand(99, 200)).toBe(100);
  });
});

describe('coefficientOfVariation', () => {
  it('is zero for a fixed price and for a single charge', () => {
    expect(coefficientOfVariation([999, 999, 999])).toBe(0);
    expect(coefficientOfVariation([999])).toBe(0);
  });

  it('rises with spread', () => {
    expect(coefficientOfVariation([900, 1100])).toBeCloseTo(0.1, 5);
  });
});

describe('clusterTransactions — grouping', () => {
  it('never mixes currencies, even for the same merchant', () => {
    const { clusters } = clusterTransactions(
      build([...monthly([1599, 1599, 1599]), ...monthly([1299, 1299, 1299], { currency: 'EUR' })]),
    );
    expect(clusters.map((c) => `${c.normalizedKey}/${c.currency}`).sort()).toEqual([
      'NETFLIX/EUR',
      'NETFLIX/USD',
    ]);
  });

  it('groups descriptors that normalize to the same key', () => {
    const { clusters } = clusterTransactions(
      build([
        { at: '2026-01-15', amount: 1599, descriptor: 'NETFLIX.COM' },
        { at: '2026-02-15', amount: 1599, descriptor: 'PURCHASE AUTHORIZED ON 02/15 NETFLIX.COM' },
        { at: '2026-03-15', amount: 1599, descriptor: 'NETFLIX.COM LOS GATOS CA' },
      ]),
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.charges).toHaveLength(3);
  });

  it('excludes pending rows by default and includes them on request', () => {
    const rows = build([
      { at: '2026-01-15', amount: 1599 },
      { at: '2026-02-15', amount: 1599, pending: true },
    ]);
    expect(clusterTransactions(rows).clusters[0]?.charges).toHaveLength(1);
    expect(clusterTransactions(rows, { includePending: true }).clusters[0]?.charges).toHaveLength(
      2,
    );
  });

  it('discards descriptors that normalize to nothing, with a reason', () => {
    const { clusters, discarded } = clusterTransactions(
      build([{ at: '2026-01-15', amount: 1599, descriptor: '#12345678' }]),
    );
    expect(clusters).toHaveLength(0);
    expect(discarded[0]?.reason).toBe('unrecoverable_descriptor');
  });
});

describe('clusterTransactions — reversals', () => {
  it('pairs a credit with the charge it undoes and removes both', () => {
    const { clusters, reversals } = clusterTransactions(
      build([
        { at: '2026-01-15', amount: 1599 },
        { at: '2026-02-15', amount: 1599 },
        { at: '2026-02-20', amount: -1599 },
        { at: '2026-03-15', amount: 1599 },
      ]),
    );
    expect(reversals).toEqual([{ reversalId: 't003', originalId: 't002' }]);
    // A refunded month cost the user nothing and is not evidence the subscription was live.
    expect(clusters[0]?.charges.map((m) => m.transaction.id)).toEqual(['t001', 't004']);
  });

  it('ignores a credit outside the reversal window', () => {
    const { reversals, clusters } = clusterTransactions(
      build([
        { at: '2026-01-15', amount: 1599 },
        { at: '2026-06-15', amount: -1599 },
      ]),
    );
    expect(reversals).toHaveLength(0);
    expect(clusters[0]?.charges).toHaveLength(1);
  });

  it('does not pair a partial credit', () => {
    const { reversals } = clusterTransactions(
      build([
        { at: '2026-01-15', amount: 1599 },
        { at: '2026-01-20', amount: -500 },
      ]),
    );
    expect(reversals).toHaveLength(0);
  });
});

describe('clusterTransactions — amount levels', () => {
  it('keeps a zero-amount trial charge as its own level', () => {
    const { clusters } = clusterTransactions(build(monthly([0, 1599, 1599, 1599])));
    const cluster = clusters[0];
    expect(cluster?.levels.map((level) => level.medianMinor)).toEqual([0, 1599]);
    // The price is the current level, not an average across the trial.
    expect(cluster?.medianAmountMinor).toBe(1599);
    expect(cluster?.amountCv).toBe(0);
  });

  it('commits a new level only once the new amount is sustained', () => {
    const { clusters } = clusterTransactions(build(monthly([999, 999, 999, 1299, 1299, 1299])));
    const cluster = clusters[0];
    expect(cluster?.levels.map((level) => level.medianMinor)).toEqual([999, 1299]);
    expect(formatPlainDate(cluster?.levels[1]?.firstSeen ?? on('1970-01-01'))).toBe('2026-04-15');
  });

  it('treats a single amount that reverts as an outlier, not a price change', () => {
    const { clusters } = clusterTransactions(build(monthly([999, 999, 1999, 999, 999])));
    const cluster = clusters[0];
    expect(cluster?.levels).toHaveLength(1);
    expect(cluster?.outliers.map((m) => m.transaction.id)).toEqual(['t003']);
    expect(cluster?.medianAmountMinor).toBe(999);
  });

  it('treats an unconfirmable amount in the final position as an outlier', () => {
    // There is no charge after it to agree with, so a rise here cannot be told apart from a
    // one-off adjustment. Announcing it a cycle late beats announcing it wrongly.
    const { clusters } = clusterTransactions(build(monthly([999, 999, 999, 1299])));
    expect(clusters[0]?.levels).toHaveLength(1);
    expect(clusters[0]?.medianAmountMinor).toBe(999);
  });
});

describe('clusterTransactions — variable amounts', () => {
  it('flags metered billing as variable and keeps every charge', () => {
    const { clusters } = clusterTransactions(
      build(monthly([8420, 10_310, 7180, 6640, 9120], { descriptor: 'DUKE ENERGY' })),
    );
    const cluster = clusters[0];
    expect(cluster?.variableAmount).toBe(true);
    expect(cluster?.charges).toHaveLength(5);
    expect(cluster?.outliers).toHaveLength(0);
    expect(cluster?.discardReason).toBeNull();
  });

  it('does not flag a fixed price as variable', () => {
    const { clusters } = clusterTransactions(build(monthly([1599, 1599, 1599])));
    expect(clusters[0]?.variableAmount).toBe(false);
  });

  it('discards a cluster whose amounts vary beyond any plausible price', () => {
    const { clusters } = clusterTransactions(
      build(monthly([500, 9900, 1200, 30_000], { descriptor: 'CORNER SHOP' })),
    );
    expect(clusters[0]?.variableAmount).toBe(false);
    expect(clusters[0]?.discardReason).toBe('amount_variance');
  });
});

describe('clusterTransactions — accounts', () => {
  it('splits a merchant billing two cards at once into separate clusters', () => {
    const { clusters } = clusterTransactions(
      build([
        ...monthly([1199, 1199, 1199], { account: 'acct-1' }),
        ...monthly([1199, 1199, 1199], { account: 'acct-2' }),
      ]),
    );
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.accountScope).sort()).toEqual(['acct-1', 'acct-2']);
  });

  it('keeps a replaced card as one subscription', () => {
    // Sequential, not concurrent: the old card fell silent when the new one started. Splitting
    // this would read as a cancellation followed by a brand-new subscription.
    const { clusters } = clusterTransactions(
      build([
        { at: '2026-01-15', amount: 1199, account: 'acct-1' },
        { at: '2026-02-15', amount: 1199, account: 'acct-1' },
        { at: '2026-03-15', amount: 1199, account: 'acct-2' },
        { at: '2026-04-15', amount: 1199, account: 'acct-2' },
      ]),
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.accountScope).toBe('all');
    expect(clusters[0]?.accountIds).toEqual(['acct-1', 'acct-2']);
  });

  it('does not split off an account with a single stray charge', () => {
    const { clusters } = clusterTransactions(
      build([
        ...monthly([1199, 1199, 1199], { account: 'acct-1' }),
        { at: '2026-02-20', amount: 1199, account: 'acct-2' },
      ]),
    );
    expect(clusters).toHaveLength(1);
  });
});

describe('clusterTransactions — determinism', () => {
  it('returns clusters in the same order whatever order the input arrives in', () => {
    const rows = build([
      ...monthly([1599, 1599, 1599]),
      ...monthly([999, 999, 999], { descriptor: 'SPOTIFY USA' }),
      ...monthly([1299, 1299, 1299], { currency: 'EUR' }),
    ]);
    const forward = clusterTransactions(rows).clusters.map((c) => c.normalizedKey + c.currency);
    const backward = clusterTransactions([...rows].reverse()).clusters.map(
      (c) => c.normalizedKey + c.currency,
    );
    expect(backward).toEqual(forward);
  });
});
