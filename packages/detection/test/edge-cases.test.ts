/**
 * One named test per case in brief §4.4.
 *
 * These are the cases that separate a detector from a product, and the reason each is a separate
 * `it` with a sentence for a name is that the acceptance criterion is *checkable*: reading the
 * test report should tell you which §4.4 behaviours the engine has, without opening the file.
 *
 * Every test drives `detectSubscriptions` end to end. Calling `detectPriceChange` or `inferCadence`
 * directly would be shorter and would prove less — most of the ways these behaviours break are
 * wiring failures between the stages, not arithmetic failures inside one, and a test that skips
 * the pipeline cannot see them.
 *
 * Fixtures are written as dates and amounts a bank would emit, with the awkward number left in
 * (Feb 28, the 31st, a £0.00 authorisation) rather than rounded off into something tidy.
 */

import {
  ANNUAL,
  FOUR_WEEKLY,
  MONTHLY,
  addDays,
  addInterval,
  annualEquivalent,
  formatPlainDate,
  intervalLabel,
  intervalsEqual,
  money,
  parsePlainDate,
  subtract,
  type RecurrenceInterval,
} from '@ledger/core';
import { describe, expect, it } from 'vitest';

import { detectSubscriptions } from '../src/detect';
import { createInMemoryRegistry } from '../src/match';
import type {
  DetectionResult,
  DetectionTransaction,
  MerchantRegistry,
  SubscriptionCandidate,
} from '../src/types';

// ── fixture helpers ────────────────────────────────────────────────────────────────────

interface ChargeOptions {
  readonly descriptor?: string | undefined;
  readonly currency?: string | undefined;
  readonly accountId?: string | undefined;
  readonly pending?: boolean | undefined;
}

let issued = 0;

function charge(
  iso: string,
  amountMinor: number,
  options: ChargeOptions = {},
): DetectionTransaction {
  issued += 1;
  return {
    id: `t${String(issued).padStart(4, '0')}`,
    postedAt: parsePlainDate(iso),
    amountMinor,
    currency: options.currency ?? 'USD',
    rawDescriptor: options.descriptor ?? 'ACME WIDGETS',
    accountId: options.accountId ?? 'acct-1',
    pending: options.pending ?? false,
  };
}

interface SeriesSpec extends ChargeOptions {
  readonly from: string;
  readonly interval: RecurrenceInterval;
  readonly count: number;
  readonly amountAt: (index: number) => number;
}

function series(spec: SeriesSpec): DetectionTransaction[] {
  const anchor = parsePlainDate(spec.from);
  const rows: DetectionTransaction[] = [];
  for (let index = 0; index < spec.count; index += 1) {
    const on = formatPlainDate(addInterval(anchor, spec.interval, index));
    rows.push(charge(on, spec.amountAt(index), spec));
  }
  return rows;
}

/** Charges on the exact dates given — for the cases where the calendar *is* the fixture. */
function on(
  isos: readonly string[],
  amountMinor: number,
  options: ChargeOptions = {},
): DetectionTransaction[] {
  return isos.map((iso) => charge(iso, amountMinor, options));
}

function detect(
  transactions: readonly DetectionTransaction[],
  todayIso: string,
  registry?: MerchantRegistry,
): DetectionResult {
  const today = parsePlainDate(todayIso);
  return registry === undefined
    ? detectSubscriptions(transactions, { today })
    : detectSubscriptions(transactions, { today, registry });
}

/** The single candidate, with a failure message that names what was found instead. */
function onlyCandidate(result: DetectionResult): SubscriptionCandidate {
  const summary = result.candidates.map(
    (candidate) =>
      `${candidate.normalizedKey}/${candidate.currency}/${intervalLabel(candidate.interval)}` +
      `/x${String(candidate.occurrences)}`,
  );
  const discarded = result.discarded.map((entry) => `${entry.normalizedKey}:${entry.reason}`);
  expect(summary, `discarded: ${discarded.join(', ') || 'nothing'}`).toHaveLength(1);
  const candidate = result.candidates[0];
  if (candidate === undefined) throw new Error('Expected exactly one candidate.');
  return candidate;
}

// ── §4.4 ───────────────────────────────────────────────────────────────────────────────

describe('brief §4.4 edge cases', () => {
  it('annual subscription detected from a single occurrence when the registry marks it annual-typical', () => {
    const registry = createInMemoryRegistry([
      {
        id: 'namecheap',
        name: 'Namecheap',
        aliases: [],
        descriptorPatterns: ['NAMECHEAP'],
        typicalIntervals: [ANNUAL],
        category: 'software',
      },
    ]);
    const rows = [charge('2025-09-12', 1298, { descriptor: 'NAMECHEAP.COM' })];

    const candidate = onlyCandidate(detect(rows, '2026-01-15', registry));
    expect(intervalsEqual(candidate.interval, ANNUAL)).toBe(true);
    expect(candidate.occurrences).toBe(1);
    expect(candidate.nextExpectedAt).toEqual(parsePlainDate('2026-09-12'));
    // Surfaced, never assumed: one charge plus an assertion is enough to *ask* the user and no
    // more, so the score lands exactly on the review threshold.
    expect(candidate.confidence).toBe(0.5);

    // The registry is doing all the work here, and the converse proves it: without something
    // outside the transaction data asserting a cadence, one charge is not a subscription.
    const unaided = detect(rows, '2026-01-15');
    expect(unaided.candidates).toHaveLength(0);
    expect(unaided.discarded).toContainEqual({
      normalizedKey: 'NAMECHEAP',
      reason: 'too_few_occurrences',
    });
  });

  it('trial converting to paid sets trialEndsAt and flags the trial', () => {
    const rows = [
      charge('2025-01-10', 0, { descriptor: 'NOTION' }),
      ...series({
        from: '2025-02-10',
        interval: MONTHLY,
        count: 4,
        descriptor: 'NOTION',
        amountAt: () => 1000,
      }),
    ];

    const candidate = onlyCandidate(detect(rows, '2025-05-20'));
    expect(candidate.isTrial).toBe(true);
    // The date of the first full-price charge — a fact, not a projection.
    expect(candidate.trialEndsAt).toEqual(parsePlainDate('2025-02-10'));
    // The £0.00 authorisation is not the price. The price is what it converted to.
    expect(candidate.medianAmountMinor).toBe(1000);
    // A trial that already converted is active, not `trialing`.
    expect(candidate.status).toBe('active');
    // A rise from nothing has no percentage, so this is a trial and not a price change.
    expect(candidate.priceChange).toBeNull();
  });

  it('price increase of 3% or more is recorded with the annualized delta', () => {
    const rows = [
      ...series({
        from: '2025-01-05',
        interval: MONTHLY,
        count: 6,
        descriptor: 'DISNEYPLUS.COM',
        amountAt: () => 1099,
      }),
      ...series({
        from: '2025-07-05',
        interval: MONTHLY,
        count: 4,
        descriptor: 'DISNEYPLUS.COM',
        amountAt: () => 1399,
      }),
    ];

    const candidate = onlyCandidate(detect(rows, '2025-11-01'));
    const change = candidate.priceChange;
    expect(change).not.toBeNull();
    expect(change?.fromMinor).toBe(1099);
    expect(change?.toMinor).toBe(1399);
    expect(change?.deltaBps).toBe(2730);
    // The date the new price first landed, not the date detection noticed it.
    expect(change?.effectiveFrom).toEqual(parsePlainDate('2025-07-05'));

    // What the rise actually costs, which is the figure the notification quotes.
    const before = annualEquivalent(money(change?.fromMinor ?? 0, 'USD'), candidate.interval);
    const after = annualEquivalent(money(change?.toMinor ?? 0, 'USD'), candidate.interval);
    expect(subtract(after, before)).toEqual(money(3600, 'USD'));

    // …and the threshold really is a threshold. A 2.5% step is a step — it clears the amount
    // band and starts a new level — but it is billing noise, not news.
    const small = [
      ...series({
        from: '2025-01-09',
        interval: MONTHLY,
        count: 6,
        descriptor: 'TERMINIX',
        amountAt: () => 20_000,
      }),
      ...series({
        from: '2025-07-09',
        interval: MONTHLY,
        count: 4,
        descriptor: 'TERMINIX',
        amountAt: () => 20_500,
      }),
    ];
    expect(onlyCandidate(detect(small, '2025-11-01')).priceChange).toBeNull();
  });

  it('a one-off amount blip that reverts is not reported as a price change', () => {
    // Month five bills 15.99 and month six is back to 10.99. One odd amount is an adjustment;
    // two in a row would be a price. Announcing a rise that turns out to be neither is worse
    // than announcing a real one a cycle late.
    const rows = series({
      from: '2025-01-06',
      interval: MONTHLY,
      count: 8,
      descriptor: 'PARAMOUNT PLUS',
      amountAt: (index) => (index === 4 ? 1599 : 1099),
    });
    const blip = rows[4];
    expect(blip).toBeDefined();

    const candidate = onlyCandidate(detect(rows, '2025-09-01'));
    expect(candidate.priceChange).toBeNull();
    expect(candidate.medianAmountMinor).toBe(1099);
    // The blip is set aside rather than averaged in, so it cannot move the price either.
    expect(candidate.transactionIds).not.toContain(blip?.id);
    expect(candidate.occurrences).toBe(7);
  });

  it('the same merchant on two cards is reported as a duplicate', () => {
    const rows = [
      ...series({
        from: '2025-01-11',
        interval: MONTHLY,
        count: 6,
        descriptor: 'DROPBOX.COM',
        accountId: 'acct-debit',
        amountAt: () => 1199,
      }),
      ...series({
        from: '2025-01-14',
        interval: MONTHLY,
        count: 6,
        descriptor: 'DROPBOX.COM 415-857-6800 CA',
        accountId: 'acct-credit',
        amountAt: () => 1199,
      }),
    ];

    const result = detect(rows, '2025-07-01');
    // Two candidates, not one merged row: a household may genuinely pay for two plans, and
    // collapsing them silently would understate the user's spend.
    expect(result.candidates).toHaveLength(2);
    expect(result.duplicates).toHaveLength(1);

    const group = result.duplicates[0];
    expect(group?.normalizedKey).toBe('DROPBOX');
    expect(group?.candidateIds).toHaveLength(2);
    expect(group?.note).toContain('acct-credit');
    expect(group?.note).toContain('acct-debit');
  });

  it('a refund is linked as a reversal and excluded from cadence', () => {
    const rows = series({
      from: '2025-01-12',
      interval: MONTHLY,
      count: 8,
      descriptor: 'PARAMOUNT PLUS',
      amountAt: () => 1199,
    });
    const refunded = rows[4];
    expect(refunded).toBeDefined();
    // The credit posts under the original descriptor, which is what a card reversal does.
    const credit = charge('2025-05-18', -1199, { descriptor: 'PARAMOUNT PLUS' });

    const result = detect([...rows, credit], '2025-09-01');
    expect(result.reversals).toEqual([{ reversalId: credit.id, originalId: refunded?.id }]);

    const candidate = onlyCandidate(result);
    // Both halves go: the credit is obviously not a subscription payment, and a charge refunded
    // in full cost the user nothing and is not evidence the subscription was live that month.
    expect(candidate.transactionIds).not.toContain(credit.id);
    expect(candidate.transactionIds).not.toContain(refunded?.id);
    // The hole it leaves is absorbed as a single missed period rather than breaking the run.
    expect(candidate.occurrences).toBe(7);
    expect(candidate.firstSeen).toEqual(parsePlainDate('2025-01-12'));
    expect(candidate.lastSeen).toEqual(parsePlainDate('2025-08-12'));
  });

  it('charges stopping marks the subscription paused after 1.5 periods and lapsed after 2.5', () => {
    const rows = series({
      from: '2025-01-15',
      interval: MONTHLY,
      count: 4,
      descriptor: 'AUDIBLE.COM BILL WA',
      amountAt: () => 1495,
    });
    // Last charge 2025-04-15. Silence is measured in periods, so the same rule works for a
    // weekly newsletter and an annual premium.
    expect(onlyCandidate(detect(rows, '2025-05-10')).status).toBe('active'); // 0.8 periods
    expect(onlyCandidate(detect(rows, '2025-06-10')).status).toBe('paused'); // 1.8 periods
    expect(onlyCandidate(detect(rows, '2025-07-20')).status).toBe('lapsed'); // 3.1 periods

    // Demoted, never discarded. A subscription that stopped is either a cancellation the user
    // forgot they made or a payment that failed, and both are worth showing.
    const lapsed = detect(rows, '2025-07-20');
    expect(lapsed.candidates).toHaveLength(1);
    expect(lapsed.discarded).toHaveLength(0);
  });

  it('a 31st-of-the-month subscription billing on Feb 28 is still monthly', () => {
    const rows = on(['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30', '2025-05-31'], 1700, {
      descriptor: 'NYTIMES*NYTIMES',
    });

    const candidate = onlyCandidate(detect(rows, '2025-06-10'));
    expect(intervalsEqual(candidate.interval, MONTHLY)).toBe(true);
    expect(candidate.occurrences).toBe(5);
    // 28, 31, 30, 31. A fixed-length comparison calls this irregular; a card issuer calls it
    // the 31st of every month, and so does the confidence score.
    expect(candidate.gapDays).toEqual([28, 31, 30, 31]);
    expect(candidate.confidenceFactors.cadenceRegularity).toBe(0.25);
  });

  it('a 31st anchor projects back to the 31st in March, not the 28th', () => {
    const rows = on(['2024-12-31', '2025-01-31', '2025-02-28'], 1700, {
      descriptor: 'NYTIMES*NYTIMES',
    });

    const candidate = onlyCandidate(detect(rows, '2025-03-05'));
    // Projected from the anchor, not stepped forward from the last charge. Stepping gives
    // Mar 28 and the error compounds every February.
    expect(candidate.nextExpectedAt).toEqual(parsePlainDate('2025-03-31'));
  });

  it('four-weekly is distinguished from monthly', () => {
    // 13 charges a year against 12. Conflating them costs the user one whole charge a year in
    // every projection, which is why four-weekly is a candidate interval and "30 days" is not.
    const rows = [
      ...series({
        from: '2025-01-06',
        interval: FOUR_WEEKLY,
        count: 8,
        descriptor: 'PUREGYM LTD LONDON',
        amountAt: () => 2299,
      }),
      ...series({
        from: '2025-01-06',
        interval: MONTHLY,
        count: 8,
        descriptor: 'PLANET FITNESS MA',
        amountAt: () => 1000,
      }),
    ];

    const result = detect(rows, '2025-09-01');
    const byKey = new Map(
      result.candidates.map((candidate) => [candidate.normalizedKey, candidate]),
    );
    expect([...byKey.keys()].sort()).toEqual(['PLANET FITNESS', 'PUREGYM']);

    const fourWeekly = byKey.get('PUREGYM');
    const monthly = byKey.get('PLANET FITNESS');
    expect(intervalsEqual(fourWeekly?.interval ?? MONTHLY, FOUR_WEEKLY)).toBe(true);
    expect(intervalsEqual(monthly?.interval ?? FOUR_WEEKLY, MONTHLY)).toBe(true);
    expect(fourWeekly?.gapDays).toEqual([28, 28, 28, 28, 28, 28, 28]);
  });

  it('amounts in different currencies are never clustered together', () => {
    // Same merchant, same descriptor, same dates, same number of minor units. Only the currency
    // differs, and a cluster that mixed them would report a median nobody was ever charged.
    const dates = [
      '2025-01-07',
      '2025-02-07',
      '2025-03-07',
      '2025-04-07',
      '2025-05-07',
      '2025-06-07',
    ];
    const rows = [
      ...on(dates, 1099, { descriptor: 'SPOTIFY USA', currency: 'USD', accountId: 'acct-us' }),
      ...on(dates, 1099, { descriptor: 'SPOTIFY USA', currency: 'EUR', accountId: 'acct-eu' }),
    ];

    const result = detect(rows, '2025-07-01');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.currency).sort()).toEqual(['EUR', 'USD']);
    for (const candidate of result.candidates) {
      expect(candidate.occurrences).toBe(6);
      const currencies = new Set(
        candidate.transactionIds.map(
          (id) => rows.find((row) => row.id === id)?.currency ?? 'MISSING',
        ),
      );
      expect(currencies).toEqual(new Set([candidate.currency]));
    }
    // The same merchant billed in two currencies is a relocation, not a duplicate.
    expect(result.duplicates).toHaveLength(0);
  });

  it('a variable-amount utility with regular cadence is surfaced and flagged', () => {
    // Metered billing: the amount moves every cycle and the cadence holds. The cadence is what
    // makes it a subscription, so the amount is allowed to wander — and is labelled as wandering.
    const readings = [6900, 8400, 9200, 7300, 8800, 7700, 9600, 7000, 8200, 8900, 7500, 8600];
    const rows = series({
      from: '2025-01-28',
      interval: MONTHLY,
      count: readings.length,
      descriptor: 'PACIFIC GAS ELECTRIC CA',
      amountAt: (index) => readings[index] ?? 8000,
    });

    const candidate = onlyCandidate(detect(rows, '2026-01-05'));
    expect(candidate.variableAmount).toBe(true);
    expect(candidate.amountCv).toBeGreaterThan(0.05);
    expect(candidate.amountCv).toBeLessThan(0.4);
    expect(candidate.occurrences).toBe(readings.length);
    // No level ever held, so there is no price step to report either.
    expect(candidate.priceChange).toBeNull();
  });

  it('an amount CV above 0.40 is discarded', () => {
    // Perfectly monthly, and still not a subscription: above the ceiling the "price" is not a
    // price. Recorded with a reason, so "why is my electricity bill missing?" has an answer.
    const readings = [1000, 9000, 2000, 12_000, 3000, 14_000, 1500, 11_000];
    const rows = series({
      from: '2025-01-19',
      interval: MONTHLY,
      count: readings.length,
      descriptor: 'HARBOR POINT MARINA',
      amountAt: (index) => readings[index] ?? 1000,
    });

    const result = detect(rows, '2025-09-01');
    expect(result.candidates).toHaveLength(0);
    expect(result.discarded).toContainEqual({
      normalizedKey: 'HARBOR POINT MARINA',
      reason: 'amount_variance',
    });
  });

  it('a single missed period is treated as a gap, not a break', () => {
    // April declines and May goes through on the same billing day. Cards decline and banks post
    // late; one skipped cycle is not the end of a subscription.
    const rows = on(['2025-01-08', '2025-02-08', '2025-03-08', '2025-05-08', '2025-06-08'], 1099, {
      descriptor: 'NETFLIX.COM',
    });

    const candidate = onlyCandidate(detect(rows, '2025-06-20'));
    expect(candidate.occurrences).toBe(5);
    expect(candidate.firstSeen).toEqual(parsePlainDate('2025-01-08'));
    expect(candidate.lastSeen).toEqual(parsePlainDate('2025-06-08'));
    expect(candidate.gapDays).toEqual([31, 28, 61, 31]);
    // The gap is priced in rather than ignored: one missed cycle costs a little confidence.
    expect(candidate.confidenceFactors.missedPeriods).toBe(-0.04);
  });

  it('two consecutive missed periods break the run', () => {
    // April and May both silent. At that point the run has ended, and June onwards is a new
    // arrangement rather than a continuation of the old one.
    const early = ['2025-01-08', '2025-02-08', '2025-03-08'];
    const late = ['2025-06-08', '2025-07-08', '2025-08-08'];
    const rows = on([...early, ...late], 1099, { descriptor: 'NETFLIX.COM' });

    const candidate = onlyCandidate(detect(rows, '2025-09-01'));
    expect(candidate.occurrences).toBe(3);
    expect(candidate.firstSeen).toEqual(parsePlainDate('2025-01-08'));
    expect(candidate.lastSeen).toEqual(parsePlainDate('2025-03-08'));
    expect(candidate.gapDays).toEqual([31, 28]);

    const laterIds = rows.slice(early.length).map((row) => row.id);
    for (const id of laterIds) expect(candidate.transactionIds).not.toContain(id);
  });
});

describe('cadence coverage', () => {
  /**
   * The false positive a real Chase statement produced roughly one run in seven: thirty-four
   * food-delivery orders over a year usually contain twelve that sit month-ish apart, and
   * `inferCadence` — which tries every charge as an anchor and keeps the best-aligned run —
   * found them every time. The other twenty-two charges were simply ignored, so a habit was
   * reported as a $38/month subscription at just over the surfacing floor.
   */
  it('34 irregular food orders are not a monthly subscription even when 12 of them align', () => {
    // Deterministic gaps between 4 and 20 days: ~34 orders across a year, several of which
    // inevitably land close to month boundaries. Amounts spread but with CV below the 0.4
    // variable-amount ceiling, mirroring the measured case (CV ≈ 0.37).
    const gaps = [6, 12, 4, 18, 9, 5, 16, 7, 11, 4, 20, 8, 13, 5, 9, 17, 6, 10, 4, 15, 8, 12, 6, 19, 7, 9, 5, 14, 10, 6, 11, 8, 16];
    const amounts = [3450, 2210, 4890, 3120, 5230, 2870, 4410, 3690, 2540, 4980, 3310, 2760, 5120, 3880, 2450, 4670, 3230, 2980, 5350, 3540, 2690, 4230, 3760, 2830, 4550, 3170, 2910, 5080, 3420, 2610, 4790, 3650, 2740, 4360];

    let date = parsePlainDate('2025-07-05');
    const orders: DetectionTransaction[] = [charge(formatPlainDate(date), amounts[0] ?? 3000, { descriptor: 'UBER * EATS SAN FRANCISCO CA' })];
    for (let index = 0; index < gaps.length; index += 1) {
      date = addDays(date, gaps[index] ?? 7);
      orders.push(charge(formatPlainDate(date), amounts[index + 1] ?? 3000, { descriptor: 'UBER * EATS SAN FRANCISCO CA' }));
    }

    const result = detectSubscriptions(orders, { today: parsePlainDate('2026-07-20') });

    expect(result.candidates).toHaveLength(0);
    // And the discard is explained, so "why is my Uber Eats not listed" has an answer.
    expect(
      result.discarded.some(
        (entry) => entry.normalizedKey.includes('UBER EATS') && entry.reason === 'cadence_explains_minority',
      ),
    ).toBe(true);
  });

  it('a real subscription with a couple of stray same-key charges still surfaces', () => {
    // Twelve clean monthly charges plus two one-off extras (a proration, an add-on) on the same
    // descriptor: coverage 12/14 ≈ 0.86, comfortably above the floor. The guard must not eat it.
    const rows = [
      ...series({ from: '2025-08-03', interval: MONTHLY, count: 12, amountAt: () => 1599, descriptor: 'STREAMCO' }),
      charge('2025-11-19', 1599, { descriptor: 'STREAMCO' }),
      charge('2026-03-11', 1599, { descriptor: 'STREAMCO' }),
    ];

    const result = detectSubscriptions(rows, { today: parsePlainDate('2026-07-20') });

    const candidate = result.candidates.find((entry) => entry.normalizedKey === 'STREAMCO');
    expect(candidate).toBeDefined();
    expect(candidate?.interval.unit).toBe('month');
  });

  it('a subscription billed twice per period on one account sits at exactly half and survives', () => {
    // Two family plans, one card: two interleaved monthly phases of the same amount and key.
    // The cadence matches one phase — exactly half the cluster — and the floor is inclusive at
    // 0.5 precisely so this real-subscription shape is not destroyed by the food-delivery guard.
    const rows = [
      ...series({ from: '2025-08-03', interval: MONTHLY, count: 12, amountAt: () => 1199, descriptor: 'MUSICCO FAMILY' }),
      ...series({ from: '2025-08-17', interval: MONTHLY, count: 12, amountAt: () => 1199, descriptor: 'MUSICCO FAMILY' }),
    ];

    const result = detectSubscriptions(rows, { today: parsePlainDate('2026-07-20') });

    expect(result.candidates.some((entry) => entry.normalizedKey.includes('MUSICCO'))).toBe(true);
  });
});
