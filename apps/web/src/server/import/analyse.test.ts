import { describe, expect, it } from 'vitest';
import { plainDate } from '@ledger/core';
import { detectSubscriptions } from '@ledger/detection';
import { type ImportedRow, inferSignConvention, toDetectionInput } from './analyse';

/**
 * The CSV analysing path, on the file that broke it.
 *
 * A real user uploaded twelve months of Chase checking activity and was offered 553 subscriptions
 * — one per row, including every Uber Eats order and a Zelle payment *received* from a friend.
 * The three defects behind that are each covered here:
 *
 *  1. the sign was thrown away, so a $40 credit looked like a $40 charge;
 *  2. inflows were never filtered, so salary and Zelle receipts were candidates;
 *  3. the detection engine was not in the path at all, so nothing distinguished eleven
 *     Uber Eats orders from eleven months of Netflix.
 *
 * The descriptors below are Chase's real shapes, not tidied approximations. ACH rows carry the
 * whole `ORIG CO NAME:` block; card rows carry a city, a state, a reference number and a date.
 * Both are hostile, and both are what the normaliser has to survive.
 */

const TODAY = plainDate(2026, 7, 27);

function row(descriptor: string, amountMinor: number, postedAt: string): ImportedRow {
  return { descriptor, amountMinor, postedAt };
}

/** A month of Chase checking, the way it actually reads. Debits negative, one credit. */
const CHASE_MONTH: readonly ImportedRow[] = [
  row(
    'ORIG CO NAME:PAYPAL   CO ENTRY DESCR:PURCHASE SEC:WEB IND ID:STEAM GAMES  ORIG ID:PAYPALSI77',
    -1632,
    '2026-07-27',
  ),
  row('UBER * EATS PENDING SAN FRANCISCO CA 727756 07/10', -5172, '2026-07-10'),
  row('PAYPAL *PATREON MEMBE 415-967-2735 CA 07/10', -1000, '2026-07-10'),
  row('Zelle payment from JOSEPHINE BARBARA 29962245370', 4000, '2026-07-18'),
  row('NETFLIX.COM          NETFLIX.COM CA', -1549, '2026-07-25'),
];

describe('sign inference', () => {
  it('reads a majority-negative file as debits-negative', () => {
    const inferred = inferSignConvention(CHASE_MONTH);
    expect(inferred.convention).toBe('debits_negative');
    expect(inferred.negativeRows).toBe(4);
    expect(inferred.positiveRows).toBe(1);
  });

  it('reads a majority-positive file as debits-positive', () => {
    // A hand-written list, or one of the several exports that write what you paid as a positive
    // number and a refund as a negative one.
    const hand: readonly ImportedRow[] = [
      row('Netflix', 1549, '2026-07-25'),
      row('Spotify', 1199, '2026-07-24'),
      row('Patreon', 1000, '2026-07-10'),
      row('Refund - Adobe', -5999, '2026-07-12'),
    ];
    const inferred = inferSignConvention(hand);
    expect(inferred.convention).toBe('debits_positive');
    expect(inferred.negativeRows).toBe(1);
    expect(inferred.positiveRows).toBe(3);
  });

  it('resolves a tie to debits-positive, the convention that reinterprets nothing', () => {
    const tied: readonly ImportedRow[] = [
      row('A', 100, '2026-07-01'),
      row('B', -100, '2026-07-02'),
    ];
    expect(inferSignConvention(tied).convention).toBe('debits_positive');
  });

  it('ignores zero-amount rows when counting the majority', () => {
    const withZeros: readonly ImportedRow[] = [
      row('A', -100, '2026-07-01'),
      row('B', 0, '2026-07-02'),
      row('C', 0, '2026-07-03'),
    ];
    const inferred = inferSignConvention(withZeros);
    expect(inferred.convention).toBe('debits_negative');
    expect(inferred.negativeRows + inferred.positiveRows).toBe(1);
  });
});

describe('normalising rows for the engine', () => {
  const options = { convention: 'debits_negative' as const, fallbackCurrency: 'USD', seed: 'user-1' };

  it('flips the sign so money leaving is positive', () => {
    const { transactions } = toDetectionInput(CHASE_MONTH, options);
    const netflix = transactions.find((tx) => tx.rawDescriptor.startsWith('NETFLIX'));
    expect(netflix?.amountMinor).toBe(1549);
  });

  it('drops the Zelle receipt instead of calling it a $40 subscription', () => {
    const { transactions, droppedInflow } = toDetectionInput(CHASE_MONTH, options);
    expect(droppedInflow).toBe(1);
    expect(transactions.map((tx) => tx.rawDescriptor)).not.toContain(
      'Zelle payment from JOSEPHINE BARBARA 29962245370',
    );
  });

  it('drops the refund, not the charges, when the file writes debits positive', () => {
    const hand: readonly ImportedRow[] = [
      row('Netflix', 1549, '2026-07-25'),
      row('Adobe refund', -5999, '2026-07-12'),
    ];
    const { transactions, droppedInflow } = toDetectionInput(hand, {
      ...options,
      convention: 'debits_positive',
    });
    expect(droppedInflow).toBe(1);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.amountMinor).toBe(1549);
  });

  it('counts an unreadable row rather than losing it silently', () => {
    const messy: readonly ImportedRow[] = [
      row('', -100, '2026-07-01'),
      row('NETFLIX.COM', -1549, 'not a date'),
      row('SPOTIFY USA', 0, '2026-07-02'),
      row('NETFLIX.COM', -1549, '2026-07-03'),
    ];
    const { transactions, droppedUnreadable } = toDetectionInput(messy, options);
    expect(droppedUnreadable).toBe(3);
    expect(transactions).toHaveLength(1);
  });

  it('gives every row a UUID-shaped id, because the evidence blob is queried against a uuid column', () => {
    // `review.supportingTransactions` feeds `evidence.transactionIds` to `inArray(transactions.id,
    // …)`. A non-UUID in there is a Postgres cast error, not a missing row.
    const { transactions } = toDetectionInput(CHASE_MONTH, options);
    for (const tx of transactions) {
      expect(tx.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('is deterministic, so re-importing the same file rewrites the same evidence', () => {
    const first = toDetectionInput(CHASE_MONTH, options);
    const second = toDetectionInput(CHASE_MONTH, options);
    expect(first.transactions.map((tx) => tx.id)).toEqual(second.transactions.map((tx) => tx.id));
  });

  it('scopes the ids to the user, so two people importing one file do not share them', () => {
    const mine = toDetectionInput(CHASE_MONTH, options);
    const theirs = toDetectionInput(CHASE_MONTH, { ...options, seed: 'user-2' });
    expect(mine.transactions[0]?.id).not.toBe(theirs.transactions[0]?.id);
  });
});

// ── the whole point ────────────────────────────────────────────────────────────────────

/** Twelve months of Netflix on the 25th, at Chase's card-descriptor shape. */
function netflixYear(): ImportedRow[] {
  const out: ImportedRow[] = [];
  for (let month = 8; month <= 19; month += 1) {
    const year = month > 12 ? 2026 : 2025;
    const inYear = month > 12 ? month - 12 : month;
    out.push(
      row(
        'NETFLIX.COM          NETFLIX.COM CA',
        -1549,
        `${String(year)}-${String(inYear).padStart(2, '0')}-25`,
      ),
    );
  }
  return out;
}

/**
 * Eleven Uber Eats orders. Same merchant every time, and that is exactly the trap: the descriptor
 * clusters perfectly, so the only thing standing between this and a "subscription" is the engine
 * noticing that the amounts and the gaps are noise.
 */
const UBER_EATS: readonly ImportedRow[] = [
  row('UBER * EATS PENDING SAN FRANCISCO CA 727756 09/03', -1844, '2025-09-03'),
  row('UBER * EATS PENDING SAN FRANCISCO CA 118420 09/19', -5172, '2025-09-19'),
  row('UBER * EATS PENDING SAN FRANCISCO CA 553091 10/02', -2310, '2025-10-02'),
  row('UBER * EATS PENDING SAN FRANCISCO CA 990183 11/14', -6703, '2025-11-14'),
  row('UBER * EATS PENDING SAN FRANCISCO CA 220417 11/28', -1299, '2025-11-28'),
  row('UBER * EATS PENDING SAN FRANCISCO CA 771205 12/21', -3985, '2025-12-21'),
  row('UBER * EATS PENDING SAN FRANCISCO CA 448193 02/07', -4420, '2026-02-07'),
  row('UBER * EATS PENDING SAN FRANCISCO CA 660238 03/11', -2999, '2026-03-11'),
  row('UBER * EATS PENDING SAN FRANCISCO CA 815720 04/26', -7734, '2026-04-26'),
  row('UBER * EATS PENDING SAN FRANCISCO CA 093366 06/08', -1560, '2026-06-08'),
  row('UBER * EATS PENDING SAN FRANCISCO CA 471908 07/10', -5172, '2026-07-10'),
];

/** Zelle to and from friends, plus a paycheque. None of it recurs on a price. */
const PEOPLE: readonly ImportedRow[] = [
  row('Zelle payment from JOSEPHINE BARBARA 29962245370', 4000, '2026-07-18'),
  row('Zelle payment from JOSEPHINE BARBARA 30118847221', 2500, '2026-06-18'),
  row('Zelle payment to MARCUS 18829930112', -6000, '2026-05-02'),
  row('ORIG CO NAME:GUSTO       CO ENTRY DESCR:PAYROLL   SEC:PPD IND ID:LEDGER', 284100, '2026-07-15'),
  row('ORIG CO NAME:GUSTO       CO ENTRY DESCR:PAYROLL   SEC:PPD IND ID:LEDGER', 284100, '2026-06-15'),
];

describe('a Chase export, end to end through the engine', () => {
  const rows = [...netflixYear(), ...UBER_EATS, ...PEOPLE];
  const sign = inferSignConvention(rows);
  const input = toDetectionInput(rows, {
    convention: sign.convention,
    fallbackCurrency: 'USD',
    seed: 'user-1',
  });
  const result = detectSubscriptions(input.transactions, { today: TODAY });
  const keys = result.candidates.map((candidate) => candidate.normalizedKey);

  it('reads the file as debits-negative', () => {
    expect(sign.convention).toBe('debits_negative');
  });

  it('never lets an inflow reach the engine', () => {
    // Three Zelle credits and two paycheques.
    expect(input.droppedInflow).toBe(4);
    expect(input.transactions.every((tx) => tx.amountMinor > 0)).toBe(true);
  });

  it('surfaces the genuine monthly', () => {
    const netflix = result.candidates.find((candidate) => candidate.normalizedKey.includes('NETFLIX'));
    expect(netflix).toBeDefined();
    expect(netflix?.medianAmountMinor).toBe(1549);
    expect(netflix?.interval).toEqual({ unit: 'month', count: 1 });
    expect(netflix?.occurrences).toBe(12);
  });

  it('does not turn eleven Uber Eats orders into a subscription', () => {
    expect(keys.some((key) => key.includes('UBER'))).toBe(false);
  });

  it('does not turn a paycheque or a Zelle receipt into a subscription', () => {
    expect(keys.some((key) => key.includes('ZELLE'))).toBe(false);
    expect(keys.some((key) => key.includes('GUSTO') || key.includes('PAYROLL'))).toBe(false);
  });

  it('says why Uber Eats was discarded rather than dropping it silently', () => {
    const uber = result.discarded.find((entry) => entry.normalizedKey.includes('UBER'));
    expect(uber).toBeDefined();
  });

  it('offers a handful of candidates, not one per row', () => {
    // The whole defect, in one assertion: 28 rows in, and nowhere near 28 suggestions out.
    expect(rows).toHaveLength(28);
    expect(result.candidates.length).toBeLessThanOrEqual(3);
  });
});
