/**
 * Tests for billing intervals and renewal projection.
 *
 * The load-bearing assertion in this file is the month-end one: an anchor of Jan 31 must produce
 * Feb 28 and then *Mar 31*. Anything that projects iteratively produces Mar 28 and the error
 * compounds forever after, so those cases are spelled out date by date rather than generated.
 *
 * A handful of tests are marked KNOWN DEFECT. They pin behaviour that is currently wrong so that
 * a fix shows up as a failing test rather than a silent change; the defects are reported, not
 * fixed here.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError, LedgerError } from './errors';
import {
  ANNUAL,
  BIWEEKLY,
  FOUR_WEEKLY,
  INTERVAL_PRESETS,
  MONTHLY,
  QUARTERLY,
  SEMIANNUAL,
  WEEKLY,
  addInterval,
  approximateDays,
  interval,
  intervalLabel,
  intervalsEqual,
  lastOccurrenceOnOrBefore,
  nextOccurrenceAfter,
  occurrence,
  occurrencesBetween,
  occurrencesPerMonth,
  occurrencesPerYear,
  type IntervalUnit,
  type RecurrenceInterval,
} from './interval';
import {
  addDays,
  comparePlainDate,
  daysInMonth,
  formatPlainDate,
  parsePlainDate,
  plainDate,
  type PlainDate,
} from './plain-date';

// ── helpers ────────────────────────────────────────────────────────────────────────────

/** `2026-01-31` → PlainDate. Keeps the expectations readable as calendar dates. */
const d = (isoDate: string): PlainDate => parsePlainDate(isoDate);
const iso = (date: PlainDate): string => formatPlainDate(date);
const isoAll = (dates: readonly PlainDate[]): string[] => dates.map(iso);

const ALL_UNITS: readonly IntervalUnit[] = ['day', 'week', 'month', 'year'];
const ALL_PRESETS: readonly RecurrenceInterval[] = [
  WEEKLY,
  BIWEEKLY,
  FOUR_WEEKLY,
  MONTHLY,
  QUARTERLY,
  SEMIANNUAL,
  ANNUAL,
];

// ── interval() ─────────────────────────────────────────────────────────────────────────

describe('interval()', () => {
  it('defaults the count to 1', () => {
    expect(interval('day')).toEqual({ unit: 'day', count: 1 });
    expect(interval('week')).toEqual({ unit: 'week', count: 1 });
    expect(interval('month')).toEqual({ unit: 'month', count: 1 });
    expect(interval('year')).toEqual({ unit: 'year', count: 1 });
  });

  it('builds an interval for every unit with an explicit count', () => {
    for (const unit of ALL_UNITS) {
      expect(interval(unit, 3)).toEqual({ unit, count: 3 });
    }
  });

  it('rejects a count of 0', () => {
    expect(() => interval('month', 0)).toThrow(LedgerError);
    expect(() => interval('month', 0)).toThrow(/positive integer, got 0/);
  });

  it('rejects negative counts', () => {
    expect(() => interval('week', -1)).toThrow(LedgerError);
    expect(() => interval('week', -12)).toThrow(/positive integer, got -12/);
  });

  it('rejects non-integer counts', () => {
    expect(() => interval('day', 1.5)).toThrow(/positive integer, got 1.5/);
    expect(() => interval('month', 0.5)).toThrow(LedgerError);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => interval('day', Number.NaN)).toThrow(/positive integer, got NaN/);
    expect(() => interval('day', Number.POSITIVE_INFINITY)).toThrow(/positive integer, got Infinity/);
    expect(() => interval('day', Number.NEGATIVE_INFINITY)).toThrow(LedgerError);
  });

  it('tags the rejection with the INVALID_INTERVAL code', () => {
    try {
      interval('year', 0);
      expect.unreachable('interval() should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe('INVALID_INTERVAL');
      expect((error as LedgerError).name).toBe('LedgerError');
    }
  });

  it('accepts large integer counts', () => {
    expect(interval('day', 400)).toEqual({ unit: 'day', count: 400 });
  });
});

// ── presets ────────────────────────────────────────────────────────────────────────────

describe('presets', () => {
  it('exposes the seven documented presets with the right unit and count', () => {
    expect(WEEKLY).toEqual({ unit: 'week', count: 1 });
    expect(BIWEEKLY).toEqual({ unit: 'week', count: 2 });
    expect(FOUR_WEEKLY).toEqual({ unit: 'week', count: 4 });
    expect(MONTHLY).toEqual({ unit: 'month', count: 1 });
    expect(QUARTERLY).toEqual({ unit: 'month', count: 3 });
    expect(SEMIANNUAL).toEqual({ unit: 'month', count: 6 });
    expect(ANNUAL).toEqual({ unit: 'year', count: 1 });
  });

  it('lists the presets for the UI in the documented order', () => {
    expect(INTERVAL_PRESETS.map((p) => p.label)).toEqual([
      'Weekly',
      'Every 2 weeks',
      'Every 4 weeks',
      'Monthly',
      'Quarterly',
      'Every 6 months',
      'Annually',
    ]);
    expect(INTERVAL_PRESETS.map((p) => p.interval)).toEqual([
      WEEKLY,
      BIWEEKLY,
      FOUR_WEEKLY,
      MONTHLY,
      QUARTERLY,
      SEMIANNUAL,
      ANNUAL,
    ]);
  });

  it('holds no duplicate presets', () => {
    const keys = INTERVAL_PRESETS.map((p) => `${p.interval.unit}:${p.interval.count}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('models quarterly as 3 months rather than 90 days', () => {
    expect(QUARTERLY.unit).toBe('month');
    expect(SEMIANNUAL.unit).toBe('month');
    expect(ANNUAL.unit).toBe('year');
  });
});

// ── intervalLabel() ────────────────────────────────────────────────────────────────────

describe('intervalLabel()', () => {
  it('labels every preset with its curated name', () => {
    expect(intervalLabel(WEEKLY)).toBe('Weekly');
    expect(intervalLabel(BIWEEKLY)).toBe('Every 2 weeks');
    expect(intervalLabel(FOUR_WEEKLY)).toBe('Every 4 weeks');
    expect(intervalLabel(MONTHLY)).toBe('Monthly');
    expect(intervalLabel(QUARTERLY)).toBe('Quarterly');
    expect(intervalLabel(SEMIANNUAL)).toBe('Every 6 months');
    expect(intervalLabel(ANNUAL)).toBe('Annually');
  });

  it('matches presets structurally, not by reference', () => {
    expect(intervalLabel({ unit: 'month', count: 1 })).toBe('Monthly');
    expect(intervalLabel(interval('week', 2))).toBe('Every 2 weeks');
    expect(intervalLabel(interval('year', 1))).toBe('Annually');
  });

  it('pluralises the unit for non-preset counts', () => {
    expect(intervalLabel(interval('day', 5))).toBe('Every 5 days');
    expect(intervalLabel(interval('week', 3))).toBe('Every 3 weeks');
    expect(intervalLabel(interval('month', 2))).toBe('Every 2 months');
    expect(intervalLabel(interval('year', 3))).toBe('Every 3 years');
  });

  it('keeps the unit singular when the count is 1', () => {
    // 'day' is the only unit whose count-of-1 form is not already a preset.
    expect(intervalLabel(interval('day', 1))).toBe('Every 1 day');
    expect(intervalLabel(interval('day'))).toBe('Every 1 day');
  });

  it('never produces an empty label', () => {
    for (const unit of ALL_UNITS) {
      for (const count of [1, 2, 5, 13]) {
        expect(intervalLabel(interval(unit, count)).length).toBeGreaterThan(0);
      }
    }
  });
});

// ── intervalsEqual() ───────────────────────────────────────────────────────────────────

describe('intervalsEqual()', () => {
  it('is true for structurally identical intervals', () => {
    expect(intervalsEqual(MONTHLY, interval('month', 1))).toBe(true);
    expect(intervalsEqual({ unit: 'week', count: 2 }, BIWEEKLY)).toBe(true);
  });

  it('is false when the count differs', () => {
    expect(intervalsEqual(WEEKLY, BIWEEKLY)).toBe(false);
    expect(intervalsEqual(MONTHLY, QUARTERLY)).toBe(false);
  });

  it('is false when the unit differs', () => {
    expect(intervalsEqual(interval('day', 7), WEEKLY)).toBe(false);
    expect(intervalsEqual(interval('month', 12), ANNUAL)).toBe(false);
  });

  it('is reflexive across every preset and asymmetric between distinct ones', () => {
    for (const a of ALL_PRESETS) {
      expect(intervalsEqual(a, a)).toBe(true);
      for (const b of ALL_PRESETS) {
        if (a === b) continue;
        expect(intervalsEqual(a, b)).toBe(false);
      }
    }
  });
});

// ── approximateDays() ──────────────────────────────────────────────────────────────────

describe('approximateDays()', () => {
  it('returns the count itself for days', () => {
    expect(approximateDays(interval('day'))).toBe(1);
    expect(approximateDays(interval('day', 5))).toBe(5);
    expect(approximateDays(interval('day', 90))).toBe(90);
  });

  it('returns seven days per week', () => {
    expect(approximateDays(WEEKLY)).toBe(7);
    expect(approximateDays(BIWEEKLY)).toBe(14);
    expect(approximateDays(FOUR_WEEKLY)).toBe(28);
  });

  it('rounds the mean Gregorian month for month intervals', () => {
    expect(approximateDays(MONTHLY)).toBe(30); // round(30.4375)
    expect(approximateDays(interval('month', 2))).toBe(61); // round(60.875)
    expect(approximateDays(QUARTERLY)).toBe(91); // round(91.3125)
    expect(approximateDays(SEMIANNUAL)).toBe(183); // round(182.625)
  });

  it('rounds the mean Julian year for year intervals', () => {
    expect(approximateDays(ANNUAL)).toBe(365); // round(365.25)
    expect(approximateDays(interval('year', 2))).toBe(731); // round(730.5)
    expect(approximateDays(interval('year', 4))).toBe(1461);
  });

  it('always returns a whole number of days', () => {
    for (const unit of ALL_UNITS) {
      for (let count = 1; count <= 24; count += 1) {
        const days = approximateDays(interval(unit, count));
        expect(Number.isInteger(days)).toBe(true);
        expect(days).toBeGreaterThan(0);
      }
    }
  });

  it('orders the presets shortest to longest', () => {
    const lengths = ALL_PRESETS.map(approximateDays);
    for (let i = 1; i < lengths.length; i += 1) {
      expect(lengths[i - 1]!).toBeLessThan(lengths[i]!);
    }
  });
});

// ── addInterval() ──────────────────────────────────────────────────────────────────────

describe('addInterval()', () => {
  it('adds days', () => {
    expect(iso(addInterval(d('2026-01-15'), interval('day', 10), 2))).toBe('2026-02-04');
    expect(iso(addInterval(d('2026-01-15'), interval('day'), 1))).toBe('2026-01-16');
  });

  it('adds weeks as seven-day multiples', () => {
    expect(iso(addInterval(d('2026-01-15'), WEEKLY, 1))).toBe('2026-01-22');
    expect(iso(addInterval(d('2026-01-15'), BIWEEKLY, 3))).toBe('2026-02-26');
    expect(iso(addInterval(d('2026-01-15'), FOUR_WEEKLY, 1))).toBe('2026-02-12');
  });

  it('adds months with month-end clamping', () => {
    expect(iso(addInterval(d('2026-01-31'), MONTHLY, 1))).toBe('2026-02-28');
    expect(iso(addInterval(d('2026-01-31'), MONTHLY, 2))).toBe('2026-03-31');
    expect(iso(addInterval(d('2026-01-31'), QUARTERLY, 1))).toBe('2026-04-30');
  });

  it('adds years as twelve-month multiples, clamping Feb 29', () => {
    expect(iso(addInterval(d('2024-02-29'), ANNUAL, 1))).toBe('2025-02-28');
    expect(iso(addInterval(d('2024-02-29'), ANNUAL, 4))).toBe('2028-02-29');
    expect(iso(addInterval(d('2024-02-29'), interval('year', 2), 1))).toBe('2026-02-28');
  });

  it('defaults the multiple to 1', () => {
    expect(iso(addInterval(d('2026-01-31'), MONTHLY))).toBe('2026-02-28');
    expect(iso(addInterval(d('2026-01-05'), WEEKLY))).toBe('2026-01-12');
  });

  it('returns the same date for a multiple of 0', () => {
    expect(iso(addInterval(d('2026-01-31'), MONTHLY, 0))).toBe('2026-01-31');
    expect(iso(addInterval(d('2026-01-31'), interval('day', 9), 0))).toBe('2026-01-31');
  });

  it('walks backwards for negative multiples in every unit', () => {
    expect(iso(addInterval(d('2026-01-15'), interval('day', 10), -2))).toBe('2025-12-26');
    expect(iso(addInterval(d('2026-01-15'), BIWEEKLY, -3))).toBe('2025-12-04');
    expect(iso(addInterval(d('2026-03-31'), MONTHLY, -1))).toBe('2026-02-28');
    expect(iso(addInterval(d('2024-02-29'), ANNUAL, -1))).toBe('2023-02-28');
  });

  it('is its own inverse for units without clamping', () => {
    const start = d('2026-06-15');
    for (const iv of [interval('day', 11), WEEKLY, MONTHLY, ANNUAL]) {
      expect(iso(addInterval(addInterval(start, iv, 5), iv, -5))).toBe('2026-06-15');
    }
  });

  it('rejects a non-integer multiple', () => {
    expect(() => addInterval(d('2026-01-01'), MONTHLY, 1.5)).toThrow(InvalidArgumentError);
    expect(() => addInterval(d('2026-01-01'), MONTHLY, 1.5)).toThrow(/integer multiple/);
  });

  it('tags a non-integer multiple with the INVALID_ARGUMENT code', () => {
    try {
      addInterval(d('2026-01-01'), WEEKLY, Number.NaN);
      expect.unreachable('addInterval() should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect((error as LedgerError).code).toBe('INVALID_ARGUMENT');
    }
  });
});

// ── occurrence() and anchor-relative projection ────────────────────────────────────────

describe('occurrence()', () => {
  it('treats index 0 as the anchor itself', () => {
    for (const iv of ALL_PRESETS) {
      expect(iso(occurrence(d('2026-01-31'), iv, 0))).toBe('2026-01-31');
    }
  });

  it('agrees with addInterval for the same multiple', () => {
    const anchor = d('2026-01-31');
    for (const iv of ALL_PRESETS) {
      for (const n of [-2, 0, 1, 7]) {
        expect(iso(occurrence(anchor, iv, n))).toBe(iso(addInterval(anchor, iv, n)));
      }
    }
  });

  it('looks backwards for negative indices', () => {
    expect(isoAll([-1, -2, -3].map((n) => occurrence(d('2026-01-31'), MONTHLY, n)))).toEqual([
      '2025-12-31',
      '2025-11-30',
      '2025-10-31',
    ]);
  });
});

describe('anchor-relative projection (the month-end drift guard)', () => {
  it('bills a Jan 31 anchor on Feb 28 and then on Mar 31, not Mar 28', () => {
    const anchor = d('2026-01-31');
    const projected = isoAll([0, 1, 2, 3, 4].map((n) => occurrence(anchor, MONTHLY, n)));

    expect(projected).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
    // The single assertion this whole module exists for.
    expect(projected[2]).toBe('2026-03-31');
    expect(projected[2]).not.toBe('2026-03-28');
  });

  it('beats iterative stepping, which loses the 31st permanently', () => {
    const anchor = d('2026-01-31');

    let stepped = anchor;
    const iterative: string[] = [iso(stepped)];
    for (let n = 0; n < 4; n += 1) {
      stepped = addInterval(stepped, MONTHLY, 1);
      iterative.push(iso(stepped));
    }

    // Stepping from the previous projection sticks on the 28th from February onwards…
    expect(iterative).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-28',
      '2026-04-28',
      '2026-05-28',
    ]);
    // …while projecting from the anchor recovers the month-end every time.
    expect(isoAll([0, 1, 2, 3, 4].map((n) => occurrence(anchor, MONTHLY, n)))[4]).toBe('2026-05-31');
  });

  it('projects a Feb 29 annual anchor onto Feb 28 and recovers Feb 29 in the next leap year', () => {
    const anchor = d('2024-02-29');
    expect(isoAll([1, 2, 3, 4].map((n) => occurrence(anchor, ANNUAL, n)))).toEqual([
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
    ]);
    expect(iso(occurrence(anchor, ANNUAL, 8))).toBe('2032-02-29');
  });

  it('recovers the month-end on a quarterly anchor', () => {
    expect(isoAll([0, 1, 2, 3, 4].map((n) => occurrence(d('2026-01-31'), QUARTERLY, n)))).toEqual([
      '2026-01-31',
      '2026-04-30',
      '2026-07-31',
      '2026-10-31',
      '2027-01-31',
    ]);
  });

  it('recovers the month-end on a semiannual anchor across a leap year', () => {
    expect(isoAll([0, 1, 2, 3].map((n) => occurrence(d('2023-08-31'), SEMIANNUAL, n)))).toEqual([
      '2023-08-31',
      '2024-02-29',
      '2024-08-31',
      '2025-02-28',
    ]);
  });

  it('keeps a 30th-of-the-month anchor off the 28th except in February', () => {
    expect(isoAll([0, 1, 2, 3].map((n) => occurrence(d('2026-12-30'), MONTHLY, n)))).toEqual([
      '2026-12-30',
      '2027-01-30',
      '2027-02-28',
      '2027-03-30',
    ]);
  });
});

// ── nextOccurrenceAfter() ──────────────────────────────────────────────────────────────

describe('nextOccurrenceAfter()', () => {
  it('is strictly after: an occurrence landing exactly on the boundary is skipped', () => {
    // 2026-02-28 is itself an occurrence, so the answer is the one after it.
    expect(iso(nextOccurrenceAfter(d('2026-01-31'), MONTHLY, d('2026-02-28')))).toBe('2026-03-31');
    expect(iso(nextOccurrenceAfter(d('2026-01-05'), WEEKLY, d('2026-01-12')))).toBe('2026-01-19');
  });

  it('skips the anchor when the boundary is the anchor itself', () => {
    expect(iso(nextOccurrenceAfter(d('2026-01-31'), MONTHLY, d('2026-01-31')))).toBe('2026-02-28');
    expect(iso(nextOccurrenceAfter(d('2026-01-05'), WEEKLY, d('2026-01-05')))).toBe('2026-01-12');
  });

  it('returns the anchor itself when the boundary is before the anchor', () => {
    expect(iso(nextOccurrenceAfter(d('2026-01-31'), MONTHLY, d('2025-06-01')))).toBe('2026-01-31');
    expect(iso(nextOccurrenceAfter(d('2026-01-31'), MONTHLY, d('2026-01-30')))).toBe('2026-01-31');
    expect(iso(nextOccurrenceAfter(d('2026-01-31'), MONTHLY, d('1999-01-01')))).toBe('2026-01-31');
  });

  it('lands on the clamped month-end rather than the drifted date', () => {
    expect(iso(nextOccurrenceAfter(d('2026-01-31'), MONTHLY, d('2026-03-01')))).toBe('2026-03-31');
    expect(iso(nextOccurrenceAfter(d('2026-01-31'), MONTHLY, d('2026-02-27')))).toBe('2026-02-28');
    expect(iso(nextOccurrenceAfter(d('2026-01-31'), MONTHLY, d('2026-04-01')))).toBe('2026-04-30');
  });

  it('works for weekly and biweekly intervals', () => {
    expect(iso(nextOccurrenceAfter(d('2026-01-05'), WEEKLY, d('2026-01-13')))).toBe('2026-01-19');
    expect(iso(nextOccurrenceAfter(d('2026-01-05'), BIWEEKLY, d('2026-01-19')))).toBe('2026-02-02');
    expect(iso(nextOccurrenceAfter(d('2026-01-05'), FOUR_WEEKLY, d('2026-01-05')))).toBe('2026-02-02');
  });

  it('works for annual intervals anchored on a leap day', () => {
    expect(iso(nextOccurrenceAfter(d('2024-02-29'), ANNUAL, d('2027-02-28')))).toBe('2028-02-29');
    expect(iso(nextOccurrenceAfter(d('2024-02-29'), ANNUAL, d('2025-01-01')))).toBe('2025-02-28');
  });

  it('works for a boundary years past the anchor', () => {
    expect(iso(nextOccurrenceAfter(d('2020-01-31'), MONTHLY, d('2030-05-15')))).toBe('2030-05-31');
    expect(iso(nextOccurrenceAfter(d('2020-01-31'), MONTHLY, d('2120-05-15')))).toBe('2120-05-31');
    expect(iso(nextOccurrenceAfter(d('2020-01-05'), WEEKLY, d('2100-01-01')))).toBe('2100-01-03');
    expect(iso(nextOccurrenceAfter(d('2020-01-31'), ANNUAL, d('2099-06-01')))).toBe('2100-01-31');
  });

  it('walks forward when the day estimate under-counts the periods (semiannual)', () => {
    // approximateDays(6 months) is 183 against a true mean of 182.625, so the arithmetic
    // estimate lands short and the forward walk has to make up the difference.
    expect(iso(nextOccurrenceAfter(d('2000-01-01'), SEMIANNUAL, d('2010-07-01')))).toBe('2011-01-01');
    expect(iso(nextOccurrenceAfter(d('2000-01-01'), SEMIANNUAL, d('2020-01-01')))).toBe('2020-07-01');
  });

  it('handles a daily interval far from the anchor', () => {
    expect(iso(nextOccurrenceAfter(d('2020-01-31'), interval('day', 3), d('2050-05-15')))).toBe('2050-05-17');
    expect(iso(nextOccurrenceAfter(d('2026-01-01'), interval('day'), d('2026-01-01')))).toBe('2026-01-02');
  });

  it('KNOWN DEFECT: gives up on monthly horizons roughly four centuries past the anchor', () => {
    // The 30-day month approximation drifts ~0.0146 of an index per month, and the convergence
    // guard is capped at 64 steps, so the search aborts instead of walking further back.
    expect(() => nextOccurrenceAfter(d('2020-01-31'), MONTHLY, d('2420-05-15'))).toThrow(LedgerError);
    expect(() => nextOccurrenceAfter(d('2020-01-31'), MONTHLY, d('2420-05-15'))).toThrow(
      /failed to converge/,
    );
    try {
      nextOccurrenceAfter(d('2020-01-31'), MONTHLY, d('2420-05-15'));
      expect.unreachable('nextOccurrenceAfter() should have thrown');
    } catch (error) {
      expect((error as LedgerError).code).toBe('INVALID_INTERVAL');
    }
    // Still fine a few decades short of the cliff.
    expect(iso(nextOccurrenceAfter(d('2020-01-31'), MONTHLY, d('2380-05-15')))).toBe('2380-05-31');
  });

  it('KNOWN DEFECT: the forward walk hits the same guard from the other side', () => {
    // approximateDays(6 months) rounds up (183 vs 182.625), so the estimate lands short and the
    // forward walk, rather than the backward one, runs out of budget. Absurd horizons, but it is
    // the same 64-step cap and the same root cause.
    expect(iso(nextOccurrenceAfter(plainDate(1, 1, 1), SEMIANNUAL, plainDate(12_000, 1, 1)))).toBe(
      '12000-07-01',
    );
    expect(() => nextOccurrenceAfter(plainDate(1, 1, 1), SEMIANNUAL, plainDate(16_000, 1, 1))).toThrow(
      /failed to converge/,
    );
  });
});

// ── lastOccurrenceOnOrBefore() ─────────────────────────────────────────────────────────

describe('lastOccurrenceOnOrBefore()', () => {
  it('returns null when the anchor is still in the future', () => {
    expect(lastOccurrenceOnOrBefore(d('2026-01-31'), MONTHLY, d('2025-12-01'))).toBeNull();
    expect(lastOccurrenceOnOrBefore(d('2026-01-31'), MONTHLY, d('2026-01-30'))).toBeNull();
    expect(lastOccurrenceOnOrBefore(d('2026-01-05'), WEEKLY, d('1999-01-01'))).toBeNull();
  });

  it('returns the anchor when the date equals the anchor', () => {
    expect(iso(lastOccurrenceOnOrBefore(d('2026-01-31'), MONTHLY, d('2026-01-31'))!)).toBe('2026-01-31');
    expect(iso(lastOccurrenceOnOrBefore(d('2026-01-05'), WEEKLY, d('2026-01-05'))!)).toBe('2026-01-05');
    expect(iso(lastOccurrenceOnOrBefore(d('2024-02-29'), ANNUAL, d('2024-02-29'))!)).toBe('2024-02-29');
  });

  it('returns the date itself when it is exactly an occurrence', () => {
    expect(iso(lastOccurrenceOnOrBefore(d('2026-01-31'), MONTHLY, d('2026-03-31'))!)).toBe('2026-03-31');
    expect(iso(lastOccurrenceOnOrBefore(d('2026-01-05'), WEEKLY, d('2026-01-19'))!)).toBe('2026-01-19');
  });

  it('walks a clamped month-end sequence correctly', () => {
    const anchor = d('2026-01-31');
    expect(iso(lastOccurrenceOnOrBefore(anchor, MONTHLY, d('2026-02-27'))!)).toBe('2026-01-31');
    expect(iso(lastOccurrenceOnOrBefore(anchor, MONTHLY, d('2026-03-30'))!)).toBe('2026-02-28');
    expect(iso(lastOccurrenceOnOrBefore(anchor, MONTHLY, d('2026-04-15'))!)).toBe('2026-03-31');
    expect(iso(lastOccurrenceOnOrBefore(anchor, MONTHLY, d('2026-05-30'))!)).toBe('2026-04-30');
    expect(iso(lastOccurrenceOnOrBefore(anchor, MONTHLY, d('2026-06-01'))!)).toBe('2026-05-31');
  });

  it('works for weekly and quarterly intervals', () => {
    expect(iso(lastOccurrenceOnOrBefore(d('2026-01-05'), WEEKLY, d('2026-01-20'))!)).toBe('2026-01-19');
    expect(iso(lastOccurrenceOnOrBefore(d('2026-01-31'), QUARTERLY, d('2026-08-01'))!)).toBe('2026-07-31');
  });

  it('works for an annual leap-day anchor', () => {
    expect(iso(lastOccurrenceOnOrBefore(d('2024-02-29'), ANNUAL, d('2027-03-01'))!)).toBe('2027-02-28');
    expect(iso(lastOccurrenceOnOrBefore(d('2024-02-29'), ANNUAL, d('2028-03-01'))!)).toBe('2028-02-29');
  });

  it('stays correct for the first couple of decades past the anchor', () => {
    expect(iso(lastOccurrenceOnOrBefore(d('2020-01-31'), MONTHLY, d('2025-06-15'))!)).toBe('2025-05-31');
    expect(iso(lastOccurrenceOnOrBefore(d('2020-01-31'), MONTHLY, d('2035-06-15'))!)).toBe('2035-05-31');
    expect(iso(lastOccurrenceOnOrBefore(d('2020-01-31'), MONTHLY, d('2040-06-15'))!)).toBe('2040-05-31');
  });

  it('KNOWN DEFECT: returns a date after the boundary for far-future monthly lookups', () => {
    // indexOfOccurrence() probes only estimate +/- 3, and the 30-day month approximation drifts
    // past that window after ~205 months, so the function silently falls back to the wrong index.
    const wrong = lastOccurrenceOnOrBefore(d('2020-01-31'), MONTHLY, d('2050-06-15'))!;
    expect(iso(wrong)).toBe('2050-10-31');
    // The contract says "at or before". It is not.
    expect(comparePlainDate(wrong, d('2050-06-15'))).toBe(1);

    // First year the drift bites for this anchor.
    expect(iso(lastOccurrenceOnOrBefore(d('2020-01-31'), MONTHLY, d('2043-06-15'))!)).toBe('2043-09-30');
    // The year before is still right, which is what makes the defect easy to miss.
    expect(iso(lastOccurrenceOnOrBefore(d('2020-01-31'), MONTHLY, d('2042-06-15'))!)).toBe('2042-05-31');
  });

  it('does not drift for units whose day approximation is exact or near-exact', () => {
    expect(iso(lastOccurrenceOnOrBefore(d('2020-01-05'), WEEKLY, d('2200-01-01'))!)).toBe('2199-12-29');
    expect(iso(lastOccurrenceOnOrBefore(d('2020-01-05'), interval('day', 3), d('2200-01-01'))!)).toBe(
      '2199-12-31',
    );
    expect(iso(lastOccurrenceOnOrBefore(d('2020-03-01'), ANNUAL, d('2200-01-01'))!)).toBe('2199-03-01');
  });
});

// ── occurrencesBetween() ───────────────────────────────────────────────────────────────

describe('occurrencesBetween()', () => {
  it('includes both bounds', () => {
    const result = occurrencesBetween(d('2026-01-01'), WEEKLY, d('2026-01-01'), d('2026-01-22'));
    expect(isoAll(result)).toEqual(['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22']);
  });

  it('returns a single entry when the window is one day wide and lands on an occurrence', () => {
    expect(isoAll(occurrencesBetween(d('2026-01-01'), WEEKLY, d('2026-01-08'), d('2026-01-08')))).toEqual([
      '2026-01-08',
    ]);
  });

  it('returns nothing when the one-day window misses every occurrence', () => {
    expect(occurrencesBetween(d('2026-01-01'), WEEKLY, d('2026-01-09'), d('2026-01-09'))).toEqual([]);
  });

  it('throws when from is after to', () => {
    expect(() => occurrencesBetween(d('2026-01-01'), WEEKLY, d('2026-03-01'), d('2026-01-01'))).toThrow(
      InvalidArgumentError,
    );
    expect(() => occurrencesBetween(d('2026-01-01'), WEEKLY, d('2026-03-01'), d('2026-01-01'))).toThrow(
      /requires from <= to/,
    );
  });

  it('tags the from/to rejection with the INVALID_ARGUMENT code', () => {
    try {
      occurrencesBetween(d('2026-01-01'), WEEKLY, d('2026-01-02'), d('2026-01-01'));
      expect.unreachable('occurrencesBetween() should have thrown');
    } catch (error) {
      expect((error as LedgerError).code).toBe('INVALID_ARGUMENT');
    }
  });

  it('returns an empty list when the window is entirely before the anchor', () => {
    expect(occurrencesBetween(d('2026-01-31'), MONTHLY, d('2025-01-01'), d('2025-12-31'))).toEqual([]);
    expect(occurrencesBetween(d('2026-01-31'), MONTHLY, d('2026-01-01'), d('2026-01-30'))).toEqual([]);
  });

  it('respects the limit', () => {
    expect(
      isoAll(occurrencesBetween(d('2026-01-01'), WEEKLY, d('2026-01-01'), d('2026-12-31'), 3)),
    ).toEqual(['2026-01-01', '2026-01-08', '2026-01-15']);
    expect(occurrencesBetween(d('2026-01-01'), WEEKLY, d('2026-01-01'), d('2026-12-31'), 0)).toEqual([]);
    expect(occurrencesBetween(d('2026-01-01'), interval('day'), d('2026-01-01'), d('2036-01-01'), 10)).toHaveLength(
      10,
    );
  });

  it('defaults the limit high enough for a decade of weekly charges', () => {
    const result = occurrencesBetween(d('2016-01-01'), WEEKLY, d('2016-01-01'), d('2026-01-01'));
    expect(result.length).toBe(522);
    expect(iso(result[0]!)).toBe('2016-01-01');
    expect(iso(result[result.length - 1]!)).toBe('2025-12-26');
  });

  it('yields eight or nine entries for a weekly interval across a sixty-day window', () => {
    const from = d('2026-01-01');
    const to = addDays(from, 59); // 60 days inclusive
    const result = occurrencesBetween(from, WEEKLY, from, to);
    expect(result.length).toBeGreaterThanOrEqual(8);
    expect(result.length).toBeLessThanOrEqual(9);
    expect(result.length).toBe(9);

    // Same window, but the anchor sits one day before it: eight land inside.
    const offset = occurrencesBetween(d('2026-01-01'), WEEKLY, addDays(from, 1), addDays(to, 1));
    expect(offset.length).toBe(8);
  });

  it('preserves month-end clamping across the window', () => {
    expect(isoAll(occurrencesBetween(d('2026-01-31'), MONTHLY, d('2026-01-31'), d('2026-06-30')))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
    ]);
  });

  it('clamps annual leap-day anchors across the window', () => {
    expect(isoAll(occurrencesBetween(d('2024-02-29'), ANNUAL, d('2024-01-01'), d('2029-12-31')))).toEqual([
      '2024-02-29',
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
      '2029-02-28',
    ]);
  });

  it('handles a window that starts mid-stream, long after the anchor', () => {
    expect(isoAll(occurrencesBetween(d('2020-01-01'), WEEKLY, d('2026-01-01'), d('2026-02-28')))).toEqual([
      '2026-01-07',
      '2026-01-14',
      '2026-01-21',
      '2026-01-28',
      '2026-02-04',
      '2026-02-11',
      '2026-02-18',
      '2026-02-25',
    ]);
  });

  it('handles day intervals', () => {
    expect(
      isoAll(occurrencesBetween(d('2026-01-01'), interval('day', 5), d('2026-01-01'), d('2026-01-21'))),
    ).toEqual(['2026-01-01', '2026-01-06', '2026-01-11', '2026-01-16', '2026-01-21']);
  });

  it('returns results in strictly ascending order', () => {
    const result = occurrencesBetween(d('2026-01-31'), MONTHLY, d('2026-01-01'), d('2029-12-31'));
    for (let i = 1; i < result.length; i += 1) {
      expect(comparePlainDate(result[i - 1]!, result[i]!)).toBe(-1);
    }
  });

  it('KNOWN DEFECT: the limit counts iterations, not results, so a mid-stream window can come back empty', () => {
    // Scanning starts two indices before the estimated start, and those out-of-window dates still
    // consume the budget. A caller asking for "up to 3" gets none at all.
    expect(occurrencesBetween(d('2020-01-01'), WEEKLY, d('2026-01-01'), d('2026-12-31'), 3)).toEqual([]);
    expect(isoAll(occurrencesBetween(d('2020-01-01'), WEEKLY, d('2026-01-01'), d('2026-12-31'), 5))).toEqual([
      '2026-01-07',
      '2026-01-14',
    ]);
  });
});

// ── annualization ──────────────────────────────────────────────────────────────────────

describe('occurrencesPerYear()', () => {
  it('gives exact rationals for every unit', () => {
    expect(occurrencesPerYear(MONTHLY)).toEqual({ numerator: 12, denominator: 1 });
    expect(occurrencesPerYear(QUARTERLY)).toEqual({ numerator: 12, denominator: 3 });
    expect(occurrencesPerYear(SEMIANNUAL)).toEqual({ numerator: 12, denominator: 6 });
    expect(occurrencesPerYear(WEEKLY)).toEqual({ numerator: 365, denominator: 7 });
    expect(occurrencesPerYear(BIWEEKLY)).toEqual({ numerator: 365, denominator: 14 });
    expect(occurrencesPerYear(FOUR_WEEKLY)).toEqual({ numerator: 365, denominator: 28 });
    expect(occurrencesPerYear(ANNUAL)).toEqual({ numerator: 1, denominator: 1 });
    expect(occurrencesPerYear(interval('year', 2))).toEqual({ numerator: 1, denominator: 2 });
    expect(occurrencesPerYear(interval('day'))).toEqual({ numerator: 365, denominator: 1 });
    expect(occurrencesPerYear(interval('day', 5))).toEqual({ numerator: 365, denominator: 5 });
  });

  it('carries integers, never floats — the whole point of the rational', () => {
    for (const unit of ALL_UNITS) {
      for (let count = 1; count <= 24; count += 1) {
        const rational = occurrencesPerYear(interval(unit, count));
        expect(Number.isInteger(rational.numerator)).toBe(true);
        expect(Number.isInteger(rational.denominator)).toBe(true);
        expect(Number.isSafeInteger(rational.numerator)).toBe(true);
        expect(Number.isSafeInteger(rational.denominator)).toBe(true);
        expect(rational.denominator).toBeGreaterThan(0);
        expect(rational.numerator).toBeGreaterThan(0);
      }
    }
  });

  it('does not pre-collapse weekly to 52 or to a float', () => {
    const weekly = occurrencesPerYear(WEEKLY);
    expect(weekly.numerator).not.toBe(52);
    expect(weekly.denominator).not.toBe(1);
    expect(weekly.numerator / weekly.denominator).toBeCloseTo(52.142_857, 5);
  });

  it('annualizes money in integer minor units: multiply first, divide once', () => {
    const priceMinor = 1999; // 19.99 per week, in minor units
    const per = occurrencesPerYear(WEEKLY);

    const scaled = priceMinor * per.numerator; // still an exact integer
    expect(Number.isSafeInteger(scaled)).toBe(true);
    expect(scaled).toBe(729_635);

    const annualMinor = Math.round(scaled / per.denominator);
    expect(Number.isInteger(annualMinor)).toBe(true);
    expect(annualMinor).toBe(104_234);

    // The naive "52 weeks" shortcut is 2.86 light over a year.
    expect(priceMinor * 52).toBe(103_948);
    expect(annualMinor - priceMinor * 52).toBe(286);
  });

  it('keeps the monthly family exact, so a year of monthly charges is exactly twelve', () => {
    const per = occurrencesPerYear(MONTHLY);
    expect((1234 * per.numerator) % per.denominator).toBe(0);
    expect((1234 * per.numerator) / per.denominator).toBe(14_808);
  });
});

describe('occurrencesPerMonth()', () => {
  it('is the yearly rational over twelve', () => {
    expect(occurrencesPerMonth(MONTHLY)).toEqual({ numerator: 12, denominator: 12 });
    expect(occurrencesPerMonth(QUARTERLY)).toEqual({ numerator: 12, denominator: 36 });
    expect(occurrencesPerMonth(SEMIANNUAL)).toEqual({ numerator: 12, denominator: 72 });
    expect(occurrencesPerMonth(WEEKLY)).toEqual({ numerator: 365, denominator: 84 });
    expect(occurrencesPerMonth(BIWEEKLY)).toEqual({ numerator: 365, denominator: 168 });
    expect(occurrencesPerMonth(FOUR_WEEKLY)).toEqual({ numerator: 365, denominator: 336 });
    expect(occurrencesPerMonth(ANNUAL)).toEqual({ numerator: 1, denominator: 12 });
    expect(occurrencesPerMonth(interval('day'))).toEqual({ numerator: 365, denominator: 12 });
  });

  it('is twelve of these to a year, for every unit and count', () => {
    for (const unit of ALL_UNITS) {
      for (let count = 1; count <= 12; count += 1) {
        const iv = interval(unit, count);
        const perYear = occurrencesPerYear(iv);
        const perMonth = occurrencesPerMonth(iv);
        expect(perMonth.numerator).toBe(perYear.numerator);
        expect(perMonth.denominator).toBe(perYear.denominator * 12);
        expect(Number.isInteger(perMonth.denominator)).toBe(true);
      }
    }
  });

  it('does not pre-collapse weekly to 4.33', () => {
    const monthly = occurrencesPerMonth(WEEKLY);
    expect(Number.isInteger(monthly.numerator)).toBe(true);
    expect(Number.isInteger(monthly.denominator)).toBe(true);
    expect(monthly.numerator / monthly.denominator).toBeCloseTo(4.345_238, 5);
  });
});

// ── property tests ─────────────────────────────────────────────────────────────────────

/**
 * Anchors are held inside 1990–2080. The projection helpers are bounded by a 64-step
 * convergence guard which, given the 30-day month approximation, only bites several centuries
 * out; staying inside a ninety-year window keeps the generators away from that cliff.
 */
const anchorArb: fc.Arbitrary<PlainDate> = fc
  .record({
    year: fc.integer({ min: 1990, max: 2080 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 31 }),
  })
  .map(({ year, month, day }) => plainDate(year, month, Math.min(day, daysInMonth(year, month))));

const intervalArb: fc.Arbitrary<RecurrenceInterval> = fc
  .record({
    unit: fc.constantFrom(...ALL_UNITS),
    count: fc.integer({ min: 1, max: 12 }),
  })
  .map(({ unit, count }) => interval(unit, count));

describe('properties', () => {
  it('occurrence() is monotonically non-decreasing in the index', () => {
    fc.assert(
      fc.property(
        anchorArb,
        intervalArb,
        fc.integer({ min: -24, max: 24 }),
        fc.integer({ min: 1, max: 36 }),
        (anchor, iv, start, span) => {
          let previous = occurrence(anchor, iv, start);
          for (let n = start + 1; n <= start + span; n += 1) {
            const current = occurrence(anchor, iv, n);
            expect(comparePlainDate(previous, current)).toBeLessThanOrEqual(0);
            previous = current;
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('occurrence() at index 0 is always the anchor', () => {
    fc.assert(
      fc.property(anchorArb, intervalArb, (anchor, iv) => {
        expect(iso(occurrence(anchor, iv, 0))).toBe(iso(anchor));
      }),
      { numRuns: 200 },
    );
  });

  it('nextOccurrenceAfter() is always strictly after the boundary', () => {
    fc.assert(
      fc.property(anchorArb, intervalArb, anchorArb, (anchor, iv, after) => {
        expect(comparePlainDate(nextOccurrenceAfter(anchor, iv, after), after)).toBe(1);
      }),
      { numRuns: 300 },
    );
  });

  it('nextOccurrenceAfter() never precedes the anchor', () => {
    fc.assert(
      fc.property(anchorArb, intervalArb, anchorArb, (anchor, iv, after) => {
        expect(comparePlainDate(nextOccurrenceAfter(anchor, iv, after), anchor)).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });

  it('occurrencesBetween() returns ascending dates inside the window', () => {
    fc.assert(
      fc.property(
        anchorArb,
        intervalArb,
        anchorArb,
        fc.integer({ min: 0, max: 400 }),
        (anchor, iv, from, span) => {
          const to = addDays(from, span);
          const result = occurrencesBetween(anchor, iv, from, to);
          for (let i = 0; i < result.length; i += 1) {
            const current = result[i]!;
            expect(comparePlainDate(current, from)).toBeGreaterThanOrEqual(0);
            expect(comparePlainDate(current, to)).toBeLessThanOrEqual(0);
            if (i > 0) expect(comparePlainDate(result[i - 1]!, current)).toBe(-1);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('intervalsEqual() is reflexive and intervalLabel() is total', () => {
    fc.assert(
      fc.property(intervalArb, (iv) => {
        expect(intervalsEqual(iv, iv)).toBe(true);
        expect(intervalsEqual(iv, { unit: iv.unit, count: iv.count })).toBe(true);
        expect(intervalLabel(iv).length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it('annualization rationals are always exact integers', () => {
    fc.assert(
      fc.property(intervalArb, (iv) => {
        const perYear = occurrencesPerYear(iv);
        const perMonth = occurrencesPerMonth(iv);
        for (const value of [
          perYear.numerator,
          perYear.denominator,
          perMonth.numerator,
          perMonth.denominator,
        ]) {
          expect(Number.isSafeInteger(value)).toBe(true);
          expect(value).toBeGreaterThan(0);
        }
        // A monetary amount scaled by the numerator stays an exact integer; the single
        // division by the denominator is the only place a fraction can appear.
        expect(Number.isSafeInteger(9_999_99 * perYear.numerator)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('approximateDays() is a positive whole number for every interval', () => {
    fc.assert(
      fc.property(intervalArb, (iv) => {
        const days = approximateDays(iv);
        expect(Number.isInteger(days)).toBe(true);
        expect(days).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });
});
