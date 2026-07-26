/**
 * Billing intervals and renewal projection.
 *
 * Two rules govern everything here:
 *
 * 1. **Project from the anchor, never iteratively.** A subscription anchored on Jan 31 bills
 *    Feb 28, then *Mar 31*. Stepping month-by-month from the previous projection gives Mar 28
 *    and the error compounds. Every occurrence is `anchor + n × interval`, computed fresh.
 * 2. **Annualizing is rational arithmetic, not multiplication by 4.33.** Weekly is 365/7 times
 *    a year, and that factor is carried as a numerator and a denominator so the money helpers
 *    can apply it in integer space and round exactly once.
 */

import { InvalidArgumentError, LedgerError } from './errors';
import {
  type PlainDate,
  addDays,
  addMonths,
  comparePlainDate,
  daysBetween,
  isAfter,
  toEpochDay,
} from './plain-date';

export type IntervalUnit = 'day' | 'week' | 'month' | 'year';

export interface RecurrenceInterval {
  readonly unit: IntervalUnit;
  /** How many units between charges. Must be ≥ 1. */
  readonly count: number;
}

export function interval(unit: IntervalUnit, count = 1): RecurrenceInterval {
  if (!Number.isInteger(count) || count < 1) {
    throw new LedgerError('INVALID_INTERVAL', `Interval count must be a positive integer, got ${String(count)}.`);
  }
  return { unit, count };
}

export const WEEKLY = interval('week', 1);
export const BIWEEKLY = interval('week', 2);
export const FOUR_WEEKLY = interval('week', 4);
export const MONTHLY = interval('month', 1);
export const QUARTERLY = interval('month', 3);
export const SEMIANNUAL = interval('month', 6);
export const ANNUAL = interval('year', 1);

/** The intervals the UI offers by default, in the order they should appear. */
export const INTERVAL_PRESETS: readonly { readonly label: string; readonly interval: RecurrenceInterval }[] = [
  { label: 'Weekly', interval: WEEKLY },
  { label: 'Every 2 weeks', interval: BIWEEKLY },
  { label: 'Every 4 weeks', interval: FOUR_WEEKLY },
  { label: 'Monthly', interval: MONTHLY },
  { label: 'Quarterly', interval: QUARTERLY },
  { label: 'Every 6 months', interval: SEMIANNUAL },
  { label: 'Annually', interval: ANNUAL },
];

export function intervalLabel(value: RecurrenceInterval): string {
  const preset = INTERVAL_PRESETS.find(
    (p) => p.interval.unit === value.unit && p.interval.count === value.count,
  );
  if (preset !== undefined) return preset.label;
  const plural = value.count === 1 ? value.unit : `${value.unit}s`;
  return `Every ${String(value.count)} ${plural}`;
}

export function intervalsEqual(a: RecurrenceInterval, b: RecurrenceInterval): boolean {
  return a.unit === b.unit && a.count === b.count;
}

/**
 * Nominal length in days. Approximate by construction — a month is not a fixed number of days —
 * so this is only for ordering, bucketing, and rough windows. Never for projecting a date.
 */
export function approximateDays(value: RecurrenceInterval): number {
  switch (value.unit) {
    case 'day':
      return value.count;
    case 'week':
      return value.count * 7;
    case 'month':
      return Math.round(value.count * 30.4375);
    case 'year':
      return Math.round(value.count * 365.25);
  }
}

// ── projection ─────────────────────────────────────────────────────────────────────────

/** `anchor + n × interval`, with month-end clamping. `n` may be negative to look backwards. */
export function addInterval(date: PlainDate, value: RecurrenceInterval, times = 1): PlainDate {
  if (!Number.isInteger(times)) throw new InvalidArgumentError('addInterval() takes an integer multiple.');
  switch (value.unit) {
    case 'day':
      return addDays(date, value.count * times);
    case 'week':
      return addDays(date, value.count * 7 * times);
    case 'month':
      return addMonths(date, value.count * times);
    case 'year':
      return addMonths(date, value.count * 12 * times);
  }
}

/** The nth occurrence counting from the anchor, where occurrence 0 is the anchor itself. */
export function occurrence(anchor: PlainDate, value: RecurrenceInterval, index: number): PlainDate {
  return addInterval(anchor, value, index);
}

/**
 * The first occurrence strictly after `after`.
 *
 * Estimates the index arithmetically then walks the last step or two, because clamping means
 * the mapping from index to date is monotonic but not perfectly uniform. The walk is bounded:
 * the estimate is never off by more than a couple of periods.
 */
export function nextOccurrenceAfter(
  anchor: PlainDate,
  value: RecurrenceInterval,
  after: PlainDate,
): PlainDate {
  let index = estimateIndex(anchor, value, after);

  // Walk back to the last occurrence that is not after `after`…
  let guard = 0;
  while (index > 0 && !isAfter(occurrence(anchor, value, index - 1), after)) {
    if (isAfter(occurrence(anchor, value, index), after)) break;
    index += 1;
    if ((guard += 1) > 64) throw new LedgerError('INVALID_INTERVAL', 'Occurrence search failed to converge.');
  }
  while (index > 0 && isAfter(occurrence(anchor, value, index - 1), after)) {
    index -= 1;
    if ((guard += 1) > 64) throw new LedgerError('INVALID_INTERVAL', 'Occurrence search failed to converge.');
  }
  while (!isAfter(occurrence(anchor, value, index), after)) {
    index += 1;
    if ((guard += 1) > 64) throw new LedgerError('INVALID_INTERVAL', 'Occurrence search failed to converge.');
  }
  return occurrence(anchor, value, index);
}

/** The most recent occurrence at or before `on`, or null if the anchor is still in the future. */
export function lastOccurrenceOnOrBefore(
  anchor: PlainDate,
  value: RecurrenceInterval,
  on: PlainDate,
): PlainDate | null {
  if (isAfter(anchor, on)) return null;
  const next = nextOccurrenceAfter(anchor, value, on);
  let index = indexOfOccurrence(anchor, value, next);
  index -= 1;
  return index < 0 ? null : occurrence(anchor, value, index);
}

/** Every occurrence in `[from, to]`, inclusive. Bounded so a bad interval cannot hang a request. */
export function occurrencesBetween(
  anchor: PlainDate,
  value: RecurrenceInterval,
  from: PlainDate,
  to: PlainDate,
  limit = 2000,
): PlainDate[] {
  if (comparePlainDate(from, to) > 0) {
    throw new InvalidArgumentError('occurrencesBetween() requires from <= to.');
  }
  const results: PlainDate[] = [];
  let index = Math.max(0, estimateIndex(anchor, value, from) - 2);
  for (let steps = 0; steps < limit; steps += 1) {
    const date = occurrence(anchor, value, index);
    if (isAfter(date, to)) break;
    if (comparePlainDate(date, from) >= 0) results.push(date);
    index += 1;
  }
  return results;
}

function estimateIndex(anchor: PlainDate, value: RecurrenceInterval, target: PlainDate): number {
  const days = daysBetween(anchor, target);
  const perPeriod = approximateDays(value);
  return Math.max(0, Math.floor(days / perPeriod));
}

function indexOfOccurrence(anchor: PlainDate, value: RecurrenceInterval, target: PlainDate): number {
  const estimate = estimateIndex(anchor, value, target);
  for (let delta = -3; delta <= 3; delta += 1) {
    const index = estimate + delta;
    if (index < 0) continue;
    if (toEpochDay(occurrence(anchor, value, index)) === toEpochDay(target)) return index;
  }
  return estimate;
}

// ── annualization ──────────────────────────────────────────────────────────────────────

export interface Rational {
  readonly numerator: number;
  readonly denominator: number;
}

/**
 * How many charges land in a year, as an exact rational.
 *
 * Weekly is 365/7 ≈ 52.14, not 52 — over a year of "annualized cost" figures that difference is
 * about a fortnight of a weekly subscription, which is exactly the kind of quiet inaccuracy that
 * makes a user stop trusting the totals.
 */
export function occurrencesPerYear(value: RecurrenceInterval): Rational {
  switch (value.unit) {
    case 'day':
      return { numerator: 365, denominator: value.count };
    case 'week':
      return { numerator: 365, denominator: 7 * value.count };
    case 'month':
      return { numerator: 12, denominator: value.count };
    case 'year':
      return { numerator: 1, denominator: value.count };
  }
}

/** How many charges land in a month, as an exact rational. Twelve of these make a year. */
export function occurrencesPerMonth(value: RecurrenceInterval): Rational {
  const perYear = occurrencesPerYear(value);
  return { numerator: perYear.numerator, denominator: perYear.denominator * 12 };
}
