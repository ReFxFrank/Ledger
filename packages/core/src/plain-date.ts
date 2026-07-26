/**
 * Calendar dates, as integers.
 *
 * A subscription renews on the 31st. `Date` will happily tell you that January 31 plus one
 * month is March 3. That single behaviour, left unattended, produces a renewal projection that
 * drifts a few days every quarter and eventually tells a user their annual plan renews on a
 * date it does not. So: no `Date` arithmetic anywhere in this module. Dates are
 * `{ year, month, day }` triples and every operation is integer arithmetic over them.
 *
 * `Date` appears only at the boundary, in `fromInstant` / `toInstant`, where a wall-clock date
 * has to be reconciled with a timestamptz and a timezone.
 */

import { InvalidArgumentError, LedgerError } from './errors';

export interface PlainDate {
  /** Proleptic Gregorian year. */
  readonly year: number;
  /** 1–12. Not zero-based; the zero-based month is the other reason `Date` gets this wrong. */
  readonly month: number;
  /** 1–31. */
  readonly day: number;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) throw new InvalidArgumentError(`Month out of range: ${String(month)}`);
  if (month === 2 && isLeapYear(year)) return 29;
  const days = DAYS_IN_MONTH[month - 1];
  if (days === undefined) throw new InvalidArgumentError(`Month out of range: ${String(month)}`);
  return days;
}

export function plainDate(year: number, month: number, day: number): PlainDate {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new InvalidArgumentError('PlainDate components must be integers.');
  }
  if (month < 1 || month > 12) {
    throw new LedgerError('INVALID_DATE', `Month out of range: ${String(month)}`);
  }
  const limit = daysInMonth(year, month);
  if (day < 1 || day > limit) {
    throw new LedgerError('INVALID_DATE', `${String(year)}-${String(month)}-${String(day)} does not exist.`);
  }
  return { year, month, day };
}

/** Parses `YYYY-MM-DD`. Rejects anything else rather than guessing. */
export function parsePlainDate(input: string): PlainDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (match === null) {
    throw new LedgerError('INVALID_DATE', `Expected YYYY-MM-DD, received ${JSON.stringify(input)}.`);
  }
  const [, y, m, d] = match;
  return plainDate(Number(y), Number(m), Number(d));
}

export function formatPlainDate(date: PlainDate): string {
  const y = String(date.year).padStart(4, '0');
  const m = String(date.month).padStart(2, '0');
  const d = String(date.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ── epoch-day conversion (Howard Hinnant's civil_from_days / days_from_civil) ──────────
// Pure integer arithmetic, valid across the whole proleptic Gregorian range, no Date involved.

export function toEpochDay(date: PlainDate): number {
  const y = date.month <= 2 ? date.year - 1 : date.year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (date.month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + date.day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

export function fromEpochDay(epochDay: number): PlainDate {
  const z = epochDay + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day };
}

// ── arithmetic ─────────────────────────────────────────────────────────────────────────

export function addDays(date: PlainDate, days: number): PlainDate {
  if (!Number.isInteger(days)) throw new InvalidArgumentError('addDays() takes an integer.');
  return fromEpochDay(toEpochDay(date) + days);
}

/**
 * Adds calendar months, clamping to the end of the target month.
 *
 * Jan 31 + 1 month = Feb 28 (or 29). This is what a card issuer does, and it is why
 * brief §4.3 insists calendar-monthly is not 30 days.
 */
export function addMonths(date: PlainDate, months: number): PlainDate {
  if (!Number.isInteger(months)) throw new InvalidArgumentError('addMonths() takes an integer.');
  const zeroBased = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(zeroBased / 12);
  const month = (((zeroBased % 12) + 12) % 12) + 1;
  const day = Math.min(date.day, daysInMonth(year, month));
  return { year, month, day };
}

export function addYears(date: PlainDate, years: number): PlainDate {
  return addMonths(date, years * 12);
}

export function daysBetween(from: PlainDate, to: PlainDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

export function comparePlainDate(a: PlainDate, b: PlainDate): -1 | 0 | 1 {
  const left = toEpochDay(a);
  const right = toEpochDay(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function isBefore(a: PlainDate, b: PlainDate): boolean {
  return comparePlainDate(a, b) < 0;
}

export function isAfter(a: PlainDate, b: PlainDate): boolean {
  return comparePlainDate(a, b) > 0;
}

export function isSameDate(a: PlainDate, b: PlainDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

export function minDate(a: PlainDate, b: PlainDate): PlainDate {
  return isBefore(a, b) ? a : b;
}

export function maxDate(a: PlainDate, b: PlainDate): PlainDate {
  return isAfter(a, b) ? a : b;
}

/** 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday. */
export function dayOfWeek(date: PlainDate): number {
  const epochDay = toEpochDay(date);
  return (((epochDay + 4) % 7) + 7) % 7;
}

export function isWeekend(date: PlainDate): boolean {
  const dow = dayOfWeek(date);
  return dow === 0 || dow === 6;
}

export function startOfMonth(date: PlainDate): PlainDate {
  return { year: date.year, month: date.month, day: 1 };
}

export function endOfMonth(date: PlainDate): PlainDate {
  return { year: date.year, month: date.month, day: daysInMonth(date.year, date.month) };
}

/**
 * True when `day` is the last day of its month — the marker for an anchor that should stay
 * pinned to month-end. A subscription first charged on Jan 31 should bill on Feb 28 *and then
 * on Mar 31*, which only works if projection runs from the anchor rather than iteratively.
 */
export function isMonthEnd(date: PlainDate): boolean {
  return date.day === daysInMonth(date.year, date.month);
}

// ── instant boundary ───────────────────────────────────────────────────────────────────

/**
 * The wall-clock date at a given instant in a given IANA timezone.
 *
 * `Intl.DateTimeFormat` is a platform global, not an import, which keeps this package free of
 * dependencies — `packages/detection` imports from here and has to stay pure.
 */
export function fromInstant(instant: Date, timeZone = 'UTC'): PlainDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const read = (type: 'year' | 'month' | 'day'): number => {
    const part = parts.find((p) => p.type === type);
    if (part === undefined) throw new LedgerError('INVALID_DATE', `Missing ${type} for zone ${timeZone}.`);
    return Number(part.value);
  };

  return plainDate(read('year'), read('month'), read('day'));
}

/**
 * The instant at which a calendar date starts in a timezone.
 *
 * Resolved by probing the offset rather than by table lookup, so DST transitions land on the
 * right side. On a spring-forward day where local midnight does not exist, this returns the
 * first instant that does — which is the behaviour a "renews on the 12th" reminder wants.
 */
export function toInstant(date: PlainDate, timeZone = 'UTC', hour = 0): Date {
  const naiveUtc = Date.UTC(date.year, date.month - 1, date.day, hour, 0, 0, 0);
  // Two passes converge for every real zone: the first corrects the base offset, the second
  // corrects the case where that correction itself crossed a DST boundary.
  let instant = naiveUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const offset = zoneOffsetMs(new Date(instant), timeZone);
    instant = naiveUtc - offset;
  }
  return new Date(instant);
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? 0 : Number(part.value);
  };

  // `hour` comes back as 24 at midnight in some ICU versions; normalise it.
  const hour = read('hour') % 24;
  const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), hour, read('minute'), read('second'));
  return asUtc - instant.getTime();
}
