/**
 * plain-date.ts — the module that stops renewal dates drifting.
 *
 * The bar here is higher than "the happy path works". Date arithmetic fails silently and
 * cumulatively: a renewal projection that is one day off never throws, it just quietly tells a
 * user the wrong thing every month until they churn. So these tests are adversarial about the
 * boundaries — leap days, month-end clamping, year rollover in both directions, negative epoch
 * days, sub-hour UTC offsets, and DST transitions — and they assert on exact values rather than
 * on "close enough".
 *
 * A note on §11's "no float arithmetic near a value that matters": there is no money in this
 * module, but the same discipline applies to date components. Every field of every PlainDate
 * this module produces must be an integer, and `toEpochDay` must return an integer. If a float
 * ever leaks into the day count, `addDays` starts producing dates that are almost right, which
 * is the worst possible failure mode. There are explicit invariants for that below.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError, LedgerError, type LedgerErrorCode } from './errors.js';
import {
  addDays,
  addMonths,
  addYears,
  comparePlainDate,
  dayOfWeek,
  daysBetween,
  daysInMonth,
  endOfMonth,
  formatPlainDate,
  fromEpochDay,
  fromInstant,
  isAfter,
  isBefore,
  isLeapYear,
  isMonthEnd,
  isSameDate,
  isWeekend,
  maxDate,
  minDate,
  parsePlainDate,
  type PlainDate,
  plainDate,
  startOfMonth,
  toEpochDay,
  toInstant,
} from './plain-date.js';

// ── helpers ────────────────────────────────────────────────────────────────────────────

/** Terse constructor for readable tables. Parsing is itself covered before anything relies on it. */
const D = (iso: string): PlainDate => parsePlainDate(iso);

const S = (date: PlainDate): string => formatPlainDate(date);

/** Returns the thrown value instead of throwing, so a test can assert on its class *and* code. */
const catchError = (fn: () => unknown): unknown => {
  try {
    fn();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
};

const codeOf = (error: unknown): LedgerErrorCode | undefined =>
  error instanceof LedgerError ? error.code : undefined;

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/**
 * IANA zones used for the instant round-trip properties.
 *
 * Deliberately chosen so that every one of them has a real local midnight on every calendar day
 * between 1900 and 2100. That excludes zones whose DST jump happens *at* midnight — see the
 * `America/Santiago` case in "documented quirks" at the bottom, which is a genuine defect in
 * `toInstant` rather than a limitation of this list.
 *
 * The list still exercises: no offset (UTC), whole-hour DST in both hemispheres, a zone with no
 * DST at all (Asia/Tokyo, Asia/Kolkata), a :30 offset (Asia/Kolkata), and a :45 offset with DST
 * on top of it (Pacific/Chatham) — which is the case that catches an implementation that assumes
 * offsets are whole hours.
 */
const ROUND_TRIP_ZONES = [
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Pacific/Chatham',
] as const;

/** Uniform over valid dates in [minYear, maxYear] — no invalid triples generated, so no filtering bias. */
const arbPlainDate = (minYear: number, maxYear: number): fc.Arbitrary<PlainDate> =>
  fc
    .tuple(fc.integer({ min: minYear, max: maxYear }), fc.integer({ min: 1, max: 12 }))
    .chain(([year, month]) =>
      fc.integer({ min: 1, max: daysInMonth(year, month) }).map((day) => plainDate(year, month, day)),
    );

/**
 * Swaps in a formatter whose `formatToParts` returns a fixed list, to reach the defensive paths
 * that a conforming ICU never triggers. Restores the real global even if the body throws.
 */
const withStubbedFormatter = (parts: readonly Intl.DateTimeFormatPart[], run: () => void): void => {
  const original = Intl.DateTimeFormat;
  const stub = function StubDateTimeFormat(): { formatToParts: () => Intl.DateTimeFormatPart[] } {
    return { formatToParts: (): Intl.DateTimeFormatPart[] => [...parts] };
  };
  Object.defineProperty(Intl, 'DateTimeFormat', { value: stub, configurable: true, writable: true });
  try {
    run();
  } finally {
    Object.defineProperty(Intl, 'DateTimeFormat', { value: original, configurable: true, writable: true });
  }
};

// ── isLeapYear ─────────────────────────────────────────────────────────────────────────

describe('isLeapYear', () => {
  it('applies the full Gregorian rule, including both century exceptions', () => {
    expect(isLeapYear(2000)).toBe(true); // divisible by 400
    expect(isLeapYear(1900)).toBe(false); // divisible by 100, not 400
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2023)).toBe(false);
    expect(isLeapYear(2026)).toBe(false);
  });

  it('treats year 0 as a leap year (proleptic Gregorian, divisible by 400)', () => {
    expect(isLeapYear(0)).toBe(true);
    expect(isLeapYear(400)).toBe(true);
    expect(isLeapYear(1600)).toBe(true);
  });

  it('agrees with February length for every year in a long run', () => {
    for (let year = 1890; year <= 2110; year += 1) {
      expect(daysInMonth(year, 2)).toBe(isLeapYear(year) ? 29 : 28);
    }
  });
});

// ── daysInMonth ────────────────────────────────────────────────────────────────────────

describe('daysInMonth', () => {
  it('returns the length of every month in a non-leap year', () => {
    expect(MONTHS.map((month) => daysInMonth(2023, month))).toEqual([
      31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ]);
  });

  it('returns the length of every month in a leap year', () => {
    expect(MONTHS.map((month) => daysInMonth(2024, month))).toEqual([
      31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ]);
  });

  it('gives February 28 days in 1900 and 29 in 2000', () => {
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });

  it('rejects month 0 and month 13 as INVALID_ARGUMENT', () => {
    for (const month of [0, 13, -1, 99]) {
      const error = catchError(() => daysInMonth(2026, month));
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(codeOf(error)).toBe('INVALID_ARGUMENT');
      expect((error as Error).message).toContain(String(month));
    }
  });

  it('rejects a non-integer month that is nominally in range', () => {
    // 1.5 passes the `< 1 || > 12` guard but indexes past the table, so the second guard has to
    // catch it. Without that guard this would return `undefined` and every caller would silently
    // produce NaN days.
    for (const month of [1.5, 2.5, 11.9]) {
      const error = catchError(() => daysInMonth(2024, month));
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(codeOf(error)).toBe('INVALID_ARGUMENT');
    }
  });

  it('always returns an integer between 28 and 31', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1600, max: 2400 }), fc.integer({ min: 1, max: 12 }), (year, month) => {
        const days = daysInMonth(year, month);
        expect(Number.isInteger(days)).toBe(true);
        expect(days).toBeGreaterThanOrEqual(28);
        expect(days).toBeLessThanOrEqual(31);
      }),
      { numRuns: 300 },
    );
  });
});

// ── plainDate ──────────────────────────────────────────────────────────────────────────

describe('plainDate', () => {
  it('builds a date from valid components', () => {
    expect(plainDate(2026, 7, 25)).toEqual({ year: 2026, month: 7, day: 25 });
  });

  it('rejects month 0 and month 13 as INVALID_DATE', () => {
    for (const month of [0, 13, -1, 14]) {
      const error = catchError(() => plainDate(2026, month, 1));
      expect(error).toBeInstanceOf(LedgerError);
      expect(codeOf(error)).toBe('INVALID_DATE');
      expect((error as Error).message).toContain('Month out of range');
    }
  });

  it('rejects February 30 and February 31', () => {
    for (const day of [30, 31]) {
      const error = catchError(() => plainDate(2026, 2, day));
      expect(codeOf(error)).toBe('INVALID_DATE');
      expect((error as Error).message).toContain('does not exist');
    }
  });

  it('accepts February 29 in 2024 and rejects it in 2023', () => {
    expect(plainDate(2024, 2, 29)).toEqual({ year: 2024, month: 2, day: 29 });
    expect(codeOf(catchError(() => plainDate(2023, 2, 29)))).toBe('INVALID_DATE');
  });

  it('accepts February 29 in 2000 and rejects it in 1900', () => {
    expect(plainDate(2000, 2, 29)).toEqual({ year: 2000, month: 2, day: 29 });
    expect(codeOf(catchError(() => plainDate(1900, 2, 29)))).toBe('INVALID_DATE');
  });

  it('rejects day 0 and day 32, and day 31 in a 30-day month', () => {
    expect(codeOf(catchError(() => plainDate(2026, 1, 0)))).toBe('INVALID_DATE');
    expect(codeOf(catchError(() => plainDate(2026, 1, 32)))).toBe('INVALID_DATE');
    expect(codeOf(catchError(() => plainDate(2026, 4, 31)))).toBe('INVALID_DATE');
    expect(codeOf(catchError(() => plainDate(2026, 1, -5)))).toBe('INVALID_DATE');
  });

  it('accepts the last day of every month in both a leap and a non-leap year', () => {
    for (const year of [2023, 2024]) {
      for (const month of MONTHS) {
        const last = daysInMonth(year, month);
        expect(plainDate(year, month, last).day).toBe(last);
        expect(codeOf(catchError(() => plainDate(year, month, last + 1)))).toBe('INVALID_DATE');
      }
    }
  });

  it('rejects non-integer components as INVALID_ARGUMENT', () => {
    const cases: readonly [number, number, number][] = [
      [2026.5, 1, 1],
      [2026, 1.5, 1],
      [2026, 1, 1.5],
      [Number.NaN, 1, 1],
      [2026, Number.NaN, 1],
      [2026, 1, Number.NaN],
      [Number.POSITIVE_INFINITY, 1, 1],
      [2026, 1, Number.NEGATIVE_INFINITY],
    ];
    for (const [year, month, day] of cases) {
      const error = catchError(() => plainDate(year, month, day));
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(codeOf(error)).toBe('INVALID_ARGUMENT');
      expect((error as Error).message).toBe('PlainDate components must be integers.');
    }
  });

  it('checks integrality before range, so 13.5 is an argument error not a date error', () => {
    expect(codeOf(catchError(() => plainDate(2026, 13.5, 1)))).toBe('INVALID_ARGUMENT');
    expect(codeOf(catchError(() => plainDate(2026, 13, 1)))).toBe('INVALID_DATE');
  });
});

// ── parsePlainDate ─────────────────────────────────────────────────────────────────────

describe('parsePlainDate', () => {
  it('parses a well-formed YYYY-MM-DD string', () => {
    expect(parsePlainDate('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 });
    expect(parsePlainDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parsePlainDate('0001-01-01')).toEqual({ year: 1, month: 1, day: 1 });
    expect(parsePlainDate('0000-02-29')).toEqual({ year: 0, month: 2, day: 29 });
  });

  it('does not treat a leading zero as octal', () => {
    expect(parsePlainDate('2026-08-09')).toEqual({ year: 2026, month: 8, day: 9 });
  });

  it('rejects a non-padded date rather than guessing', () => {
    const error = catchError(() => parsePlainDate('2026-2-8'));
    expect(codeOf(error)).toBe('INVALID_DATE');
    expect((error as Error).message).toBe('Expected YYYY-MM-DD, received "2026-2-8".');
  });

  it('rejects other common date shapes', () => {
    const rejected = [
      '28/02/2026',
      '02-28-2026',
      '2026/02/28',
      '',
      '   ',
      'garbage',
      'not-a-date',
      '2026-02-28T00:00:00Z',
      '20260228',
      '2026-02-28-01',
      '26-02-28',
      '+2026-02-28',
      '2026-02-2a',
      '99999-02-28',
    ];
    for (const input of rejected) {
      expect(codeOf(catchError(() => parsePlainDate(input)))).toBe('INVALID_DATE');
    }
  });

  it('quotes the raw input in the error, including when the input was blank', () => {
    expect((catchError(() => parsePlainDate('')) as Error).message).toBe('Expected YYYY-MM-DD, received "".');
    expect((catchError(() => parsePlainDate('  x  ')) as Error).message).toBe(
      'Expected YYYY-MM-DD, received "  x  ".',
    );
  });

  it('trims surrounding whitespace before matching', () => {
    expect(parsePlainDate('  2026-02-28  ')).toEqual({ year: 2026, month: 2, day: 28 });
    expect(parsePlainDate('\t2026-02-28\n')).toEqual({ year: 2026, month: 2, day: 28 });
  });

  it('applies calendar validation to a syntactically valid string', () => {
    expect(codeOf(catchError(() => parsePlainDate('2023-02-29')))).toBe('INVALID_DATE');
    expect(codeOf(catchError(() => parsePlainDate('2026-02-30')))).toBe('INVALID_DATE');
    expect(codeOf(catchError(() => parsePlainDate('2026-13-01')))).toBe('INVALID_DATE');
    expect(codeOf(catchError(() => parsePlainDate('2026-00-10')))).toBe('INVALID_DATE');
    expect(codeOf(catchError(() => parsePlainDate('2026-04-31')))).toBe('INVALID_DATE');
    expect(codeOf(catchError(() => parsePlainDate('2026-01-00')))).toBe('INVALID_DATE');
  });
});

// ── formatPlainDate ────────────────────────────────────────────────────────────────────

describe('formatPlainDate', () => {
  it('zero-pads month and day', () => {
    expect(formatPlainDate(plainDate(2026, 2, 8))).toBe('2026-02-08');
    expect(formatPlainDate(plainDate(2026, 12, 31))).toBe('2026-12-31');
  });

  it('zero-pads a year below 1000 to four digits', () => {
    expect(formatPlainDate(plainDate(999, 1, 2))).toBe('0999-01-02');
    expect(formatPlainDate(plainDate(99, 1, 2))).toBe('0099-01-02');
    expect(formatPlainDate(plainDate(9, 1, 2))).toBe('0009-01-02');
    expect(formatPlainDate(plainDate(1, 1, 1))).toBe('0001-01-01');
    expect(formatPlainDate(plainDate(0, 1, 1))).toBe('0000-01-01');
  });

  it('does not truncate a year above 9999', () => {
    expect(formatPlainDate(plainDate(12_345, 6, 7))).toBe('12345-06-07');
  });

  it('round-trips through parsePlainDate for any year 0..9999', () => {
    fc.assert(
      fc.property(arbPlainDate(0, 9999), (date) => {
        expect(parsePlainDate(formatPlainDate(date))).toEqual(date);
      }),
      { numRuns: 500 },
    );
  });
});

// ── epoch day conversion ───────────────────────────────────────────────────────────────

describe('toEpochDay / fromEpochDay', () => {
  it('anchors the epoch at 1970-01-01', () => {
    expect(toEpochDay(D('1970-01-01'))).toBe(0);
    expect(fromEpochDay(0)).toEqual(D('1970-01-01'));
  });

  it('counts backwards through the epoch without an off-by-one', () => {
    expect(toEpochDay(D('1969-12-31'))).toBe(-1);
    expect(fromEpochDay(-1)).toEqual(D('1969-12-31'));
    expect(toEpochDay(D('1969-01-01'))).toBe(-365);
    expect(toEpochDay(D('1970-01-02'))).toBe(1);
  });

  it('matches known anchors', () => {
    // 2000-03-01 is the pivot of the Hinnant algorithm's March-based year, so it is the single
    // most valuable anchor in the whole module.
    expect(toEpochDay(D('2000-03-01'))).toBe(11_017);
    expect(fromEpochDay(11_017)).toEqual(D('2000-03-01'));

    expect(toEpochDay(D('2000-02-29'))).toBe(11_016);
    expect(toEpochDay(D('2024-02-29'))).toBe(19_782);
    expect(fromEpochDay(19_782)).toEqual(D('2024-02-29'));

    expect(toEpochDay(D('1900-01-01'))).toBe(-25_567);
    expect(toEpochDay(D('2026-07-25'))).toBe(20_659);
    expect(toEpochDay(D('0001-01-01'))).toBe(-719_162);
    expect(fromEpochDay(-719_162)).toEqual(D('0001-01-01'));
  });

  it('steps by exactly one across the 1900 and 2000 century boundaries', () => {
    // 1900 is not a leap year, 2000 is. An implementation that gets the century rule wrong
    // produces a discontinuity here and nowhere else.
    expect(toEpochDay(D('1900-03-01')) - toEpochDay(D('1900-02-28'))).toBe(1);
    expect(toEpochDay(D('2000-03-01')) - toEpochDay(D('2000-02-29'))).toBe(1);
    expect(toEpochDay(D('2000-02-29')) - toEpochDay(D('2000-02-28'))).toBe(1);
    expect(toEpochDay(D('2100-03-01')) - toEpochDay(D('2100-02-28'))).toBe(1);
  });

  it('always returns an integer, including for pre-epoch dates', () => {
    for (const iso of ['0001-01-01', '1066-10-14', '1900-01-01', '1969-12-31', '2026-07-25', '9999-12-31']) {
      expect(Number.isInteger(toEpochDay(D(iso)))).toBe(true);
    }
  });

  it('round-trips date -> epochDay -> date across 1900..2100', () => {
    fc.assert(
      fc.property(arbPlainDate(1900, 2100), (date) => {
        expect(fromEpochDay(toEpochDay(date))).toEqual(date);
      }),
      { numRuns: 1000 },
    );
  });

  it('round-trips date -> epochDay -> date across the far wider 0001..9999 range', () => {
    fc.assert(
      fc.property(arbPlainDate(1, 9999), (date) => {
        expect(fromEpochDay(toEpochDay(date))).toEqual(date);
      }),
      { numRuns: 1000 },
    );
  });

  it('round-trips epochDay -> date -> epochDay, including negative epoch days', () => {
    fc.assert(
      fc.property(fc.integer({ min: -730_000, max: 2_932_000 }), (epochDay) => {
        expect(toEpochDay(fromEpochDay(epochDay))).toBe(epochDay);
      }),
      { numRuns: 1000 },
    );
  });

  it('produces only valid, integral calendar dates for any epoch day', () => {
    fc.assert(
      fc.property(fc.integer({ min: -730_000, max: 2_932_000 }), (epochDay) => {
        const date = fromEpochDay(epochDay);
        expect(Number.isInteger(date.year)).toBe(true);
        expect(Number.isInteger(date.month)).toBe(true);
        expect(Number.isInteger(date.day)).toBe(true);
        expect(date.month).toBeGreaterThanOrEqual(1);
        expect(date.month).toBeLessThanOrEqual(12);
        expect(date.day).toBeGreaterThanOrEqual(1);
        expect(date.day).toBeLessThanOrEqual(daysInMonth(date.year, date.month));
        // The strongest check: it must survive the constructor's own validation.
        expect(plainDate(date.year, date.month, date.day)).toEqual(date);
      }),
      { numRuns: 500 },
    );
  });

  it('is strictly monotonic — consecutive epoch days are consecutive calendar days', () => {
    let previous = toEpochDay(D('2023-12-01'));
    for (let step = 1; step <= 400; step += 1) {
      const current = toEpochDay(addDays(D('2023-12-01'), step));
      expect(current - previous).toBe(1);
      previous = current;
    }
  });
});

// ── addDays ────────────────────────────────────────────────────────────────────────────

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays(D('2026-01-31'), 1)).toEqual(D('2026-02-01'));
    expect(addDays(D('2026-04-30'), 1)).toEqual(D('2026-05-01'));
    expect(addDays(D('2026-03-01'), -1)).toEqual(D('2026-02-28'));
  });

  it('crosses a year boundary in both directions', () => {
    expect(addDays(D('2026-12-31'), 1)).toEqual(D('2027-01-01'));
    expect(addDays(D('2027-01-01'), -1)).toEqual(D('2026-12-31'));
    expect(addDays(D('2026-12-25'), 10)).toEqual(D('2027-01-04'));
  });

  it('crosses a leap day', () => {
    expect(addDays(D('2024-02-28'), 1)).toEqual(D('2024-02-29'));
    expect(addDays(D('2024-02-28'), 2)).toEqual(D('2024-03-01'));
    expect(addDays(D('2024-03-01'), -1)).toEqual(D('2024-02-29'));
    expect(addDays(D('2023-02-28'), 1)).toEqual(D('2023-03-01'));
    expect(addDays(D('1900-02-28'), 1)).toEqual(D('1900-03-01'));
    expect(addDays(D('2000-02-28'), 1)).toEqual(D('2000-02-29'));
  });

  it('counts a full year correctly in leap and non-leap years', () => {
    expect(addDays(D('2024-02-29'), 365)).toEqual(D('2025-02-28'));
    expect(addDays(D('2023-01-01'), 365)).toEqual(D('2024-01-01'));
    expect(addDays(D('2024-01-01'), 365)).toEqual(D('2024-12-31'));
    expect(addDays(D('2024-01-01'), 366)).toEqual(D('2025-01-01'));
  });

  it('handles zero and large offsets, and crosses the epoch', () => {
    expect(addDays(D('2026-07-25'), 0)).toEqual(D('2026-07-25'));
    expect(addDays(D('1970-01-01'), -1)).toEqual(D('1969-12-31'));
    expect(addDays(D('1970-01-01'), -365)).toEqual(D('1969-01-01'));
    expect(addDays(D('1970-01-01'), 20_659)).toEqual(D('2026-07-25'));
  });

  it('rejects a non-integer day count', () => {
    for (const days of [1.5, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = catchError(() => addDays(D('2026-07-25'), days));
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(codeOf(error)).toBe('INVALID_ARGUMENT');
      expect((error as Error).message).toBe('addDays() takes an integer.');
    }
  });

  it('is invertible and additive for any date and offset', () => {
    fc.assert(
      fc.property(arbPlainDate(1900, 2100), fc.integer({ min: -20_000, max: 20_000 }), (date, days) => {
        expect(addDays(addDays(date, days), -days)).toEqual(date);
        expect(daysBetween(date, addDays(date, days))).toBe(days);
      }),
      { numRuns: 500 },
    );
  });

  it('composes: addDays(addDays(d, a), b) === addDays(d, a + b)', () => {
    fc.assert(
      fc.property(
        arbPlainDate(1900, 2100),
        fc.integer({ min: -5000, max: 5000 }),
        fc.integer({ min: -5000, max: 5000 }),
        (date, a, b) => {
          expect(addDays(addDays(date, a), b)).toEqual(addDays(date, a + b));
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ── addMonths (the reason this module exists) ──────────────────────────────────────────

describe('addMonths', () => {
  it('clamps Jan 31 + 1 month to the end of February', () => {
    expect(addMonths(D('2026-01-31'), 1)).toEqual(D('2026-02-28'));
  });

  it('clamps Jan 31 + 1 month to Feb 29 in a leap year', () => {
    expect(addMonths(D('2024-01-31'), 1)).toEqual(D('2024-02-29'));
    expect(addMonths(D('2000-01-31'), 1)).toEqual(D('2000-02-29'));
    expect(addMonths(D('1900-01-31'), 1)).toEqual(D('1900-02-28'));
  });

  it('does not let the clamp persist — Jan 31 + 2 months is Mar 31, not Mar 28', () => {
    expect(addMonths(D('2026-01-31'), 2)).toEqual(D('2026-03-31'));
    expect(addMonths(D('2024-01-31'), 2)).toEqual(D('2024-03-31'));
    expect(addMonths(D('2026-01-31'), 3)).toEqual(D('2026-04-30'));
    expect(addMonths(D('2026-01-31'), 4)).toEqual(D('2026-05-31'));
  });

  it('differs from iterating one month at a time, which is exactly the drift being prevented', () => {
    const anchor = D('2026-01-31');

    // Projecting from the anchor: correct.
    expect(addMonths(anchor, 2)).toEqual(D('2026-03-31'));

    // Iterating: the February clamp becomes permanent and the renewal date walks backwards.
    const iterated = addMonths(addMonths(anchor, 1), 1);
    expect(iterated).toEqual(D('2026-03-28'));
    expect(iterated).not.toEqual(addMonths(anchor, 2));

    // Over a year the iterative version loses three days; the anchored one loses none.
    let walk = anchor;
    for (let step = 0; step < 12; step += 1) walk = addMonths(walk, 1);
    expect(walk).toEqual(D('2027-01-28'));
    expect(addMonths(anchor, 12)).toEqual(D('2027-01-31'));
  });

  it('clamps a 31-day month into a 30-day month', () => {
    expect(addMonths(D('2026-08-31'), 1)).toEqual(D('2026-09-30'));
    expect(addMonths(D('2026-03-31'), 1)).toEqual(D('2026-04-30'));
    expect(addMonths(D('2026-05-31'), 1)).toEqual(D('2026-06-30'));
    expect(addMonths(D('2026-10-31'), 1)).toEqual(D('2026-11-30'));
    expect(addMonths(D('2026-12-31'), 1)).toEqual(D('2027-01-31'));
  });

  it('clamps identically for negative months', () => {
    expect(addMonths(D('2026-03-31'), -1)).toEqual(D('2026-02-28'));
    expect(addMonths(D('2024-03-31'), -1)).toEqual(D('2024-02-29'));
    expect(addMonths(D('2026-05-31'), -3)).toEqual(D('2026-02-28'));
    expect(addMonths(D('2026-10-31'), -11)).toEqual(D('2025-11-30'));
    expect(addMonths(D('2026-01-31'), -2)).toEqual(D('2025-11-30'));
  });

  it('crosses a year boundary forwards and backwards', () => {
    expect(addMonths(D('2026-11-15'), 3)).toEqual(D('2027-02-15'));
    expect(addMonths(D('2026-12-15'), 1)).toEqual(D('2027-01-15'));
    expect(addMonths(D('2026-02-15'), -3)).toEqual(D('2025-11-15'));
    expect(addMonths(D('2026-01-15'), -1)).toEqual(D('2025-12-15'));
    expect(addMonths(D('2026-01-31'), -1)).toEqual(D('2025-12-31'));
    expect(addMonths(D('2026-06-15'), 30)).toEqual(D('2028-12-15'));
    expect(addMonths(D('2026-06-15'), -30)).toEqual(D('2023-12-15'));
    expect(addMonths(D('2026-01-31'), 13)).toEqual(D('2027-02-28'));
  });

  it('is a no-op for zero months', () => {
    expect(addMonths(D('2026-01-31'), 0)).toEqual(D('2026-01-31'));
    expect(addMonths(D('2024-02-29'), 0)).toEqual(D('2024-02-29'));
  });

  it('handles a leap-day anchor', () => {
    expect(addMonths(D('2024-02-29'), 1)).toEqual(D('2024-03-29'));
    expect(addMonths(D('2024-02-29'), 12)).toEqual(D('2025-02-28'));
    expect(addMonths(D('2024-02-29'), 48)).toEqual(D('2028-02-29'));
    expect(addMonths(D('2024-02-29'), -12)).toEqual(D('2023-02-28'));
  });

  it('lands on the same day-of-month whenever the target month is long enough', () => {
    for (const month of MONTHS) {
      expect(addMonths(plainDate(2026, month, 15), 1).day).toBe(15);
      expect(addMonths(plainDate(2026, month, 1), 1).day).toBe(1);
      expect(addMonths(plainDate(2026, month, 28), 1).day).toBe(28);
    }
  });

  it('rejects a non-integer month count', () => {
    for (const months of [1.5, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = catchError(() => addMonths(D('2026-07-25'), months));
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(codeOf(error)).toBe('INVALID_ARGUMENT');
      expect((error as Error).message).toBe('addMonths() takes an integer.');
    }
  });

  it('never produces a day beyond the target month, for any date and offset', () => {
    fc.assert(
      fc.property(arbPlainDate(1900, 2100), fc.integer({ min: -2400, max: 2400 }), (date, months) => {
        const result = addMonths(date, months);
        expect(result.month).toBeGreaterThanOrEqual(1);
        expect(result.month).toBeLessThanOrEqual(12);
        expect(result.day).toBeGreaterThanOrEqual(1);
        expect(result.day).toBeLessThanOrEqual(daysInMonth(result.year, result.month));
        expect(result.day).toBeLessThanOrEqual(date.day);
        expect(Number.isInteger(result.year)).toBe(true);
        // Always a real date.
        expect(plainDate(result.year, result.month, result.day)).toEqual(result);
      }),
      { numRuns: 1000 },
    );
  });

  it('advances the month index by exactly the offset, for any date and offset', () => {
    fc.assert(
      fc.property(arbPlainDate(1900, 2100), fc.integer({ min: -2400, max: 2400 }), (date, months) => {
        const before = date.year * 12 + (date.month - 1);
        const result = addMonths(date, months);
        const after = result.year * 12 + (result.month - 1);
        expect(after - before).toBe(months);
      }),
      { numRuns: 1000 },
    );
  });

  it('is invertible whenever no clamping can occur (day <= 28)', () => {
    fc.assert(
      fc.property(
        fc
          .tuple(fc.integer({ min: 1900, max: 2100 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
          .map(([year, month, day]) => plainDate(year, month, day)),
        fc.integer({ min: -1200, max: 1200 }),
        (date, months) => {
          expect(addMonths(addMonths(date, months), -months)).toEqual(date);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ── addYears ───────────────────────────────────────────────────────────────────────────

describe('addYears', () => {
  it('adds whole years, clamping a leap day', () => {
    expect(addYears(D('2026-07-25'), 1)).toEqual(D('2027-07-25'));
    expect(addYears(D('2024-02-29'), 1)).toEqual(D('2025-02-28'));
    expect(addYears(D('2024-02-29'), 4)).toEqual(D('2028-02-29'));
    expect(addYears(D('2024-02-29'), -1)).toEqual(D('2023-02-28'));
    expect(addYears(D('2026-07-25'), -1)).toEqual(D('2025-07-25'));
    expect(addYears(D('2026-07-25'), 0)).toEqual(D('2026-07-25'));
  });

  it('clamps across a non-leap century', () => {
    expect(addYears(D('2096-02-29'), 4)).toEqual(D('2100-02-28'));
  });

  it('is exactly addMonths(d, years * 12)', () => {
    fc.assert(
      fc.property(arbPlainDate(1900, 2100), fc.integer({ min: -200, max: 200 }), (date, years) => {
        expect(addYears(date, years)).toEqual(addMonths(date, years * 12));
      }),
      { numRuns: 500 },
    );
  });

  it('matches addMonths(d, 12) for a single year on month-end anchors', () => {
    for (const iso of ['2026-01-31', '2024-02-29', '2026-04-30', '2026-12-31']) {
      expect(addMonths(D(iso), 12)).toEqual(addYears(D(iso), 1));
      expect(addMonths(D(iso), -12)).toEqual(addYears(D(iso), -1));
    }
  });
});

// ── daysBetween ────────────────────────────────────────────────────────────────────────

describe('daysBetween', () => {
  it('is positive when `to` is later and negative when earlier', () => {
    expect(daysBetween(D('2026-01-01'), D('2026-01-31'))).toBe(30);
    expect(daysBetween(D('2026-01-31'), D('2026-01-01'))).toBe(-30);
  });

  it('is zero for the same date', () => {
    expect(daysBetween(D('2026-07-25'), D('2026-07-25'))).toBe(0);
  });

  it('includes the leap day when the span covers one', () => {
    expect(daysBetween(D('2024-02-28'), D('2024-03-01'))).toBe(2);
    expect(daysBetween(D('2023-02-28'), D('2023-03-01'))).toBe(1);
    expect(daysBetween(D('2024-01-01'), D('2025-01-01'))).toBe(366);
    expect(daysBetween(D('2026-01-01'), D('2027-01-01'))).toBe(365);
  });

  it('spans the epoch and a century boundary', () => {
    expect(daysBetween(D('1969-12-31'), D('1970-01-01'))).toBe(1);
    expect(daysBetween(D('1900-01-01'), D('1970-01-01'))).toBe(25_567);
    expect(daysBetween(D('1899-12-31'), D('1900-03-01'))).toBe(60);
  });

  it('is antisymmetric and additive', () => {
    fc.assert(
      fc.property(arbPlainDate(1900, 2100), arbPlainDate(1900, 2100), arbPlainDate(1900, 2100), (a, b, c) => {
        expect(daysBetween(a, b)).toBe(-daysBetween(b, a));
        expect(daysBetween(a, b) + daysBetween(b, c)).toBe(daysBetween(a, c));
        expect(Number.isInteger(daysBetween(a, b))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('agrees with addDays in both directions', () => {
    fc.assert(
      fc.property(arbPlainDate(1900, 2100), arbPlainDate(1900, 2100), (a, b) => {
        expect(addDays(a, daysBetween(a, b))).toEqual(b);
      }),
      { numRuns: 500 },
    );
  });
});

// ── comparison ─────────────────────────────────────────────────────────────────────────

describe('comparePlainDate / isBefore / isAfter / isSameDate', () => {
  it('returns exactly -1, 0 or 1', () => {
    expect(comparePlainDate(D('2026-01-01'), D('2026-01-02'))).toBe(-1);
    expect(comparePlainDate(D('2026-01-02'), D('2026-01-01'))).toBe(1);
    expect(comparePlainDate(D('2026-01-01'), D('2026-01-01'))).toBe(0);
    // Not merely "negative": a raw difference would return -365 here.
    expect(comparePlainDate(D('2025-01-01'), D('2026-01-01'))).toBe(-1);
    expect(comparePlainDate(D('2026-01-01'), D('2025-01-01'))).toBe(1);
  });

  it('orders across month and year boundaries, not lexically by day', () => {
    expect(comparePlainDate(D('2026-01-31'), D('2026-02-01'))).toBe(-1);
    expect(comparePlainDate(D('2026-12-31'), D('2027-01-01'))).toBe(-1);
    expect(comparePlainDate(D('1969-12-31'), D('1970-01-01'))).toBe(-1);
  });

  it('drives isBefore and isAfter consistently', () => {
    const earlier = D('2026-01-01');
    const later = D('2026-06-15');
    expect(isBefore(earlier, later)).toBe(true);
    expect(isBefore(later, earlier)).toBe(false);
    expect(isAfter(later, earlier)).toBe(true);
    expect(isAfter(earlier, later)).toBe(false);
  });

  it('treats equal dates as neither before nor after', () => {
    const date = D('2026-07-25');
    expect(isBefore(date, D('2026-07-25'))).toBe(false);
    expect(isAfter(date, D('2026-07-25'))).toBe(false);
    expect(isSameDate(date, D('2026-07-25'))).toBe(true);
  });

  it('compares isSameDate componentwise', () => {
    expect(isSameDate(D('2026-07-25'), D('2026-07-25'))).toBe(true);
    expect(isSameDate(D('2026-07-25'), D('2026-07-26'))).toBe(false);
    expect(isSameDate(D('2026-07-25'), D('2026-08-25'))).toBe(false);
    expect(isSameDate(D('2026-07-25'), D('2027-07-25'))).toBe(false);
  });

  it('agrees with isSameDate, isBefore and isAfter for any pair (trichotomy)', () => {
    fc.assert(
      fc.property(arbPlainDate(1900, 2100), arbPlainDate(1900, 2100), (a, b) => {
        const order = comparePlainDate(a, b);
        expect([-1, 0, 1]).toContain(order);
        expect(isBefore(a, b)).toBe(order === -1);
        expect(isAfter(a, b)).toBe(order === 1);
        expect(isSameDate(a, b)).toBe(order === 0);
        expect(comparePlainDate(b, a)).toBe(-order);
      }),
      { numRuns: 500 },
    );
  });
});

describe('minDate / maxDate', () => {
  it('picks the earlier and later date', () => {
    const earlier = D('2026-01-01');
    const later = D('2026-06-15');
    expect(minDate(earlier, later)).toEqual(earlier);
    expect(minDate(later, earlier)).toEqual(earlier);
    expect(maxDate(earlier, later)).toEqual(later);
    expect(maxDate(later, earlier)).toEqual(later);
  });

  it('returns the second argument by identity when the dates are equal', () => {
    const a = plainDate(2026, 7, 25);
    const b = plainDate(2026, 7, 25);
    expect(minDate(a, b)).toBe(b);
    expect(maxDate(a, b)).toBe(b);
  });

  it('returns one of its arguments by identity, never a copy', () => {
    const a = plainDate(2026, 1, 1);
    const b = plainDate(2027, 1, 1);
    expect(minDate(a, b)).toBe(a);
    expect(maxDate(a, b)).toBe(b);
  });

  it('is consistent with comparePlainDate for any pair', () => {
    fc.assert(
      fc.property(arbPlainDate(1900, 2100), arbPlainDate(1900, 2100), (a, b) => {
        const min = minDate(a, b);
        const max = maxDate(a, b);
        expect(comparePlainDate(min, max)).toBeLessThanOrEqual(0);
        expect(isSameDate(min, a) || isSameDate(min, b)).toBe(true);
        expect(isSameDate(max, a) || isSameDate(max, b)).toBe(true);
        expect(daysBetween(min, max)).toBe(Math.abs(daysBetween(a, b)));
      }),
      { numRuns: 500 },
    );
  });
});

// ── day of week ────────────────────────────────────────────────────────────────────────

describe('dayOfWeek / isWeekend', () => {
  it('knows that 1970-01-01 was a Thursday', () => {
    expect(dayOfWeek(D('1970-01-01'))).toBe(4);
  });

  it('matches known days of the week', () => {
    expect(dayOfWeek(D('2026-07-25'))).toBe(6); // Saturday
    expect(dayOfWeek(D('2026-07-26'))).toBe(0); // Sunday
    expect(dayOfWeek(D('2026-07-27'))).toBe(1); // Monday
    expect(dayOfWeek(D('2000-01-01'))).toBe(6); // Saturday
    expect(dayOfWeek(D('2024-02-29'))).toBe(4); // Thursday
    expect(dayOfWeek(D('1900-01-01'))).toBe(1); // Monday
  });

  it('stays non-negative for pre-epoch dates', () => {
    // A bare `%` would return -3 here; the double-modulo exists for exactly this case.
    expect(dayOfWeek(D('1969-12-31'))).toBe(3); // Wednesday
    expect(dayOfWeek(D('1969-12-28'))).toBe(0); // Sunday
    expect(dayOfWeek(D('0001-01-01'))).toBe(1); // Monday, proleptic Gregorian
  });

  it('advances by one per day and wraps every seven, over a long run', () => {
    let date = D('1969-12-01');
    for (let step = 0; step < 500; step += 1) {
      const dow = dayOfWeek(date);
      expect(Number.isInteger(dow)).toBe(true);
      expect(dow).toBeGreaterThanOrEqual(0);
      expect(dow).toBeLessThanOrEqual(6);
      expect(dayOfWeek(addDays(date, 1))).toBe((dow + 1) % 7);
      expect(dayOfWeek(addDays(date, 7))).toBe(dow);
      date = addDays(date, 1);
    }
  });

  it('flags Saturday and Sunday as the weekend and nothing else', () => {
    expect(isWeekend(D('2026-07-25'))).toBe(true); // Sat
    expect(isWeekend(D('2026-07-26'))).toBe(true); // Sun
    expect(isWeekend(D('2026-07-24'))).toBe(false); // Fri
    expect(isWeekend(D('2026-07-27'))).toBe(false); // Mon
    expect(isWeekend(D('2026-07-28'))).toBe(false);
    expect(isWeekend(D('2026-07-29'))).toBe(false);
    expect(isWeekend(D('2026-07-30'))).toBe(false);
  });

  it('agrees with dayOfWeek for any date', () => {
    fc.assert(
      fc.property(arbPlainDate(1900, 2100), (date) => {
        const dow = dayOfWeek(date);
        expect(isWeekend(date)).toBe(dow === 0 || dow === 6);
      }),
      { numRuns: 500 },
    );
  });
});

// ── month boundaries ───────────────────────────────────────────────────────────────────

describe('startOfMonth / endOfMonth / isMonthEnd', () => {
  it('moves to the first of the month without touching year or month', () => {
    expect(startOfMonth(D('2026-02-15'))).toEqual(D('2026-02-01'));
    expect(startOfMonth(D('2026-02-01'))).toEqual(D('2026-02-01'));
    expect(startOfMonth(D('2024-02-29'))).toEqual(D('2024-02-01'));
    expect(startOfMonth(D('2026-12-31'))).toEqual(D('2026-12-01'));
  });

  it('moves to the last of the month, leap-aware', () => {
    expect(endOfMonth(D('2026-02-15'))).toEqual(D('2026-02-28'));
    expect(endOfMonth(D('2024-02-15'))).toEqual(D('2024-02-29'));
    expect(endOfMonth(D('1900-02-15'))).toEqual(D('1900-02-28'));
    expect(endOfMonth(D('2000-02-15'))).toEqual(D('2000-02-29'));
    expect(endOfMonth(D('2026-04-01'))).toEqual(D('2026-04-30'));
    expect(endOfMonth(D('2026-12-31'))).toEqual(D('2026-12-31'));
  });

  it('produces the right end-of-month for every month of a leap and a non-leap year', () => {
    expect(MONTHS.map((month) => S(endOfMonth(plainDate(2024, month, 1))))).toEqual([
      '2024-01-31',
      '2024-02-29',
      '2024-03-31',
      '2024-04-30',
      '2024-05-31',
      '2024-06-30',
      '2024-07-31',
      '2024-08-31',
      '2024-09-30',
      '2024-10-31',
      '2024-11-30',
      '2024-12-31',
    ]);
    expect(S(endOfMonth(plainDate(2023, 2, 1)))).toBe('2023-02-28');
  });

  it('recognises month end, and distinguishes Feb 28 in a leap year from Feb 28 in a normal one', () => {
    expect(isMonthEnd(D('2026-02-28'))).toBe(true);
    expect(isMonthEnd(D('2024-02-28'))).toBe(false); // Feb 29 exists in 2024
    expect(isMonthEnd(D('2024-02-29'))).toBe(true);
    expect(isMonthEnd(D('2026-01-31'))).toBe(true);
    expect(isMonthEnd(D('2026-04-30'))).toBe(true);
    expect(isMonthEnd(D('2026-04-29'))).toBe(false);
    expect(isMonthEnd(D('2026-12-31'))).toBe(true);
    expect(isMonthEnd(D('2026-07-01'))).toBe(false);
  });

  it('holds the expected relationships for any date', () => {
    fc.assert(
      fc.property(arbPlainDate(1900, 2100), (date) => {
        const start = startOfMonth(date);
        const end = endOfMonth(date);
        expect(start.day).toBe(1);
        expect(start.year).toBe(date.year);
        expect(start.month).toBe(date.month);
        expect(end.year).toBe(date.year);
        expect(end.month).toBe(date.month);
        expect(isMonthEnd(end)).toBe(true);
        expect(isMonthEnd(start)).toBe(daysInMonth(date.year, date.month) === 1);
        expect(isMonthEnd(date)).toBe(isSameDate(date, end));
        expect(daysBetween(start, end)).toBe(daysInMonth(date.year, date.month) - 1);
        // The day after the end of a month is the first of the next month.
        expect(addDays(end, 1).day).toBe(1);
        expect(addDays(start, -1)).toEqual(endOfMonth(addMonths(date, -1)));
      }),
      { numRuns: 500 },
    );
  });

  it('keeps a month-end anchor pinned when projection runs from the anchor', () => {
    // Brief §4.3: a subscription first charged Jan 31 bills Feb 28 and then Mar 31.
    const anchor = D('2026-01-31');
    expect(isMonthEnd(anchor)).toBe(true);
    const projected = [0, 1, 2, 3, 4, 5].map((n) => S(addMonths(anchor, n)));
    expect(projected).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
    ]);
    for (const iso of projected) expect(isMonthEnd(D(iso))).toBe(true);
  });
});

// ── fromInstant ────────────────────────────────────────────────────────────────────────

describe('fromInstant', () => {
  it('defaults to UTC', () => {
    expect(fromInstant(new Date('2026-07-25T06:30:00Z'))).toEqual(D('2026-07-25'));
    expect(fromInstant(new Date(0))).toEqual(D('1970-01-01'));
  });

  it('reads a different calendar day per zone for the same instant', () => {
    // 06:30 UTC is still the 24th on the US west coast.
    const morning = new Date('2026-07-25T06:30:00Z');
    expect(S(fromInstant(morning, 'UTC'))).toBe('2026-07-25');
    expect(S(fromInstant(morning, 'America/Los_Angeles'))).toBe('2026-07-24');
    expect(S(fromInstant(morning, 'Asia/Tokyo'))).toBe('2026-07-25');

    // 15:30 UTC is already the 26th in Tokyo.
    const evening = new Date('2026-07-25T15:30:00Z');
    expect(S(fromInstant(evening, 'UTC'))).toBe('2026-07-25');
    expect(S(fromInstant(evening, 'America/Los_Angeles'))).toBe('2026-07-25');
    expect(S(fromInstant(evening, 'Asia/Tokyo'))).toBe('2026-07-26');
  });

  it('resolves an instant that straddles a month, year and leap-day boundary', () => {
    const newYear = new Date('2027-01-01T02:00:00Z');
    expect(S(fromInstant(newYear, 'UTC'))).toBe('2027-01-01');
    expect(S(fromInstant(newYear, 'America/New_York'))).toBe('2026-12-31');
    expect(S(fromInstant(newYear, 'Asia/Tokyo'))).toBe('2027-01-01');

    const leap = new Date('2024-03-01T02:00:00Z');
    expect(S(fromInstant(leap, 'UTC'))).toBe('2024-03-01');
    expect(S(fromInstant(leap, 'America/Los_Angeles'))).toBe('2024-02-29');
  });

  it('handles a sub-hour offset zone', () => {
    const instant = new Date('2026-07-25T18:30:00Z');
    expect(S(fromInstant(instant, 'Asia/Kolkata'))).toBe('2026-07-26'); // +05:30 → exactly midnight
    expect(S(fromInstant(new Date('2026-07-25T18:29:59Z'), 'Asia/Kolkata'))).toBe('2026-07-25');
    expect(S(fromInstant(instant, 'Pacific/Chatham'))).toBe('2026-07-26'); // +12:45
  });

  it('handles a pre-epoch instant', () => {
    expect(S(fromInstant(new Date('1969-12-31T23:59:59Z'), 'UTC'))).toBe('1969-12-31');
    expect(S(fromInstant(new Date('1969-12-31T23:59:59Z'), 'Asia/Tokyo'))).toBe('1970-01-01');
  });

  it('returns a fully validated PlainDate', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -2_208_988_800_000, max: 4_102_444_800_000 }),
        fc.constantFrom(...ROUND_TRIP_ZONES),
        (millis, zone) => {
          const date = fromInstant(new Date(millis), zone);
          expect(plainDate(date.year, date.month, date.day)).toEqual(date);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('throws INVALID_DATE if the platform formatter omits a component', () => {
    // Defensive path — a conforming ICU always supplies year/month/day, but the module refuses
    // to fabricate a date if one is missing rather than producing NaN.
    withStubbedFormatter([], () => {
      const error = catchError(() => fromInstant(new Date(0), 'UTC'));
      expect(error).toBeInstanceOf(LedgerError);
      expect(codeOf(error)).toBe('INVALID_DATE');
      expect((error as Error).message).toBe('Missing year for zone UTC.');
    });

    withStubbedFormatter([{ type: 'year', value: '2026' }], () => {
      const error = catchError(() => fromInstant(new Date(0), 'Asia/Tokyo'));
      expect(codeOf(error)).toBe('INVALID_DATE');
      expect((error as Error).message).toBe('Missing month for zone Asia/Tokyo.');
    });

    withStubbedFormatter(
      [
        { type: 'year', value: '2026' },
        { type: 'month', value: '02' },
      ],
      () => {
        const error = catchError(() => fromInstant(new Date(0), 'UTC'));
        expect(codeOf(error)).toBe('INVALID_DATE');
        expect((error as Error).message).toBe('Missing day for zone UTC.');
      },
    );
  });

  it('restores the real formatter after stubbing', () => {
    expect(S(fromInstant(new Date(0), 'UTC'))).toBe('1970-01-01');
  });
});

// ── toInstant ──────────────────────────────────────────────────────────────────────────

describe('toInstant', () => {
  it('defaults to UTC midnight', () => {
    expect(toInstant(D('2026-02-28')).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(toInstant(D('1970-01-01')).toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(toInstant(D('1970-01-01')).getTime()).toBe(0);
  });

  it('shifts by the zone offset', () => {
    expect(toInstant(D('2026-02-28'), 'America/New_York').toISOString()).toBe('2026-02-28T05:00:00.000Z');
    expect(toInstant(D('2026-02-28'), 'America/Los_Angeles').toISOString()).toBe('2026-02-28T08:00:00.000Z');
    expect(toInstant(D('2026-02-28'), 'Asia/Tokyo').toISOString()).toBe('2026-02-27T15:00:00.000Z');
    expect(toInstant(D('2026-02-28'), 'Asia/Kolkata').toISOString()).toBe('2026-02-27T18:30:00.000Z');
  });

  it('honours the hour argument', () => {
    expect(toInstant(D('2026-02-28'), 'UTC', 12).toISOString()).toBe('2026-02-28T12:00:00.000Z');
    expect(toInstant(D('2026-02-28'), 'America/Los_Angeles', 12).toISOString()).toBe('2026-02-28T20:00:00.000Z');
    expect(toInstant(D('2026-02-28'), 'Asia/Tokyo', 9).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(toInstant(D('2026-02-28'), 'UTC', 23).toISOString()).toBe('2026-02-28T23:00:00.000Z');
  });

  it('picks the right side of a spring-forward transition', () => {
    // US DST 2026 starts 02:00 local on Sunday 8 March. Midnight on the 8th still exists and is
    // still EST (-05:00); by the 9th the zone is EDT (-04:00).
    expect(toInstant(D('2026-03-07'), 'America/New_York').toISOString()).toBe('2026-03-07T05:00:00.000Z');
    expect(toInstant(D('2026-03-08'), 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(toInstant(D('2026-03-09'), 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');

    expect(S(fromInstant(toInstant(D('2026-03-08'), 'America/New_York'), 'America/New_York'))).toBe('2026-03-08');
  });

  it('picks the right side of a fall-back transition', () => {
    // US DST 2026 ends 02:00 local on Sunday 1 November. Midnight on the 1st is still EDT
    // (-04:00) — the naive single-pass answer would land an hour out.
    expect(toInstant(D('2026-10-31'), 'America/New_York').toISOString()).toBe('2026-10-31T04:00:00.000Z');
    expect(toInstant(D('2026-11-01'), 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(toInstant(D('2026-11-02'), 'America/New_York').toISOString()).toBe('2026-11-02T05:00:00.000Z');

    expect(S(fromInstant(toInstant(D('2026-11-01'), 'America/New_York'), 'America/New_York'))).toBe('2026-11-01');
  });

  it('handles southern-hemisphere DST, which runs the other way', () => {
    expect(S(fromInstant(toInstant(D('2026-04-05'), 'Australia/Sydney'), 'Australia/Sydney'))).toBe('2026-04-05');
    expect(S(fromInstant(toInstant(D('2026-10-04'), 'Australia/Sydney'), 'Australia/Sydney'))).toBe('2026-10-04');
  });

  it('handles a :45 offset zone with DST on top of it', () => {
    // Pacific/Chatham is +12:45 / +13:45. Any implementation that rounds offsets to whole hours
    // lands on the wrong calendar day here.
    for (const iso of ['2026-01-15', '2026-04-05', '2026-07-25', '2026-09-27']) {
      expect(S(fromInstant(toInstant(D(iso), 'Pacific/Chatham'), 'Pacific/Chatham'))).toBe(iso);
    }
  });

  it('round-trips every single day of a DST year, for every zone', () => {
    const mismatches: string[] = [];
    const first = toEpochDay(D('2026-01-01'));
    const last = toEpochDay(D('2026-12-31'));
    for (const zone of ROUND_TRIP_ZONES) {
      for (let epochDay = first; epochDay <= last; epochDay += 1) {
        const date = fromEpochDay(epochDay);
        const actual = S(fromInstant(toInstant(date, zone), zone));
        if (actual !== S(date)) mismatches.push(`${zone}: ${S(date)} -> ${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('round-trips across every DST transition weekend from 1970 to 2100', () => {
    const mismatches: string[] = [];
    for (const zone of ROUND_TRIP_ZONES) {
      for (let year = 1970; year <= 2100; year += 1) {
        // Sweep the two windows in which essentially every zone schedules a transition.
        for (const [month, from, to] of [
          [3, 1, 31],
          [10, 1, 31],
        ] as const) {
          for (let day = from; day <= to; day += 1) {
            const date = plainDate(year, month, day);
            const actual = S(fromInstant(toInstant(date, zone), zone));
            if (actual !== S(date)) mismatches.push(`${zone}: ${S(date)} -> ${actual}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('PROPERTY: fromInstant(toInstant(date, zone), zone) === date for 1900..2100', () => {
    fc.assert(
      fc.property(arbPlainDate(1900, 2100), fc.constantFrom(...ROUND_TRIP_ZONES), (date, zone) => {
        expect(fromInstant(toInstant(date, zone), zone)).toEqual(date);
      }),
      { numRuns: 1500 },
    );
  });

  it('PROPERTY: the round trip survives a non-midnight hour too', () => {
    fc.assert(
      fc.property(
        arbPlainDate(1900, 2100),
        fc.constantFrom(...ROUND_TRIP_ZONES),
        fc.integer({ min: 0, max: 23 }),
        (date, zone, hour) => {
          expect(fromInstant(toInstant(date, zone, hour), zone)).toEqual(date);
        },
      ),
      { numRuns: 800 },
    );
  });

  it('is monotonic — a later date never maps to an earlier instant', () => {
    fc.assert(
      fc.property(arbPlainDate(1900, 2100), fc.constantFrom(...ROUND_TRIP_ZONES), (date, zone) => {
        const today = toInstant(date, zone).getTime();
        const tomorrow = toInstant(addDays(date, 1), zone).getTime();
        expect(tomorrow).toBeGreaterThan(today);
        // A calendar day is 23, 24 or 25 hours long depending on DST; never anything else.
        const hours = (tomorrow - today) / 3_600_000;
        expect(hours).toBeGreaterThanOrEqual(23);
        expect(hours).toBeLessThanOrEqual(25);
      }),
      { numRuns: 500 },
    );
  });

  it('tolerates a formatter that omits the time components rather than producing NaN', () => {
    // Exercises the `part === undefined ? 0` fallback inside the offset probe.
    withStubbedFormatter([], () => {
      const instant = toInstant(D('2026-02-28'), 'UTC');
      expect(instant).toBeInstanceOf(Date);
      expect(Number.isNaN(instant.getTime())).toBe(false);
    });
  });
});

// ── integer-purity invariants ──────────────────────────────────────────────────────────

describe('integer purity', () => {
  it('never lets a float reach a date component through any operation', () => {
    fc.assert(
      fc.property(
        arbPlainDate(1900, 2100),
        fc.integer({ min: -5000, max: 5000 }),
        fc.integer({ min: -600, max: 600 }),
        (date, days, months) => {
          const produced: readonly PlainDate[] = [
            addDays(date, days),
            addMonths(date, months),
            addYears(date, Math.trunc(months / 12)),
            startOfMonth(date),
            endOfMonth(date),
            fromEpochDay(toEpochDay(date)),
            minDate(date, addDays(date, days)),
            maxDate(date, addDays(date, days)),
          ];
          for (const value of produced) {
            expect(Number.isInteger(value.year)).toBe(true);
            expect(Number.isInteger(value.month)).toBe(true);
            expect(Number.isInteger(value.day)).toBe(true);
            expect(Number.isSafeInteger(toEpochDay(value))).toBe(true);
          }
          expect(Number.isInteger(daysBetween(date, addDays(date, days)))).toBe(true);
          expect(Number.isInteger(dayOfWeek(date))).toBe(true);
          expect(Number.isInteger(daysInMonth(date.year, date.month))).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('rejects every fractional input at the boundary instead of truncating it', () => {
    expect(codeOf(catchError(() => addDays(D('2026-07-25'), 1.000_000_1)))).toBe('INVALID_ARGUMENT');
    expect(codeOf(catchError(() => addMonths(D('2026-07-25'), 1.000_000_1)))).toBe('INVALID_ARGUMENT');
    expect(codeOf(catchError(() => plainDate(2026, 7, 25.000_000_1)))).toBe('INVALID_ARGUMENT');
  });
});

// ── documented quirks ──────────────────────────────────────────────────────────────────

/**
 * These lock in what the implementation *currently* does at edges where the behaviour is either
 * wrong or surprising. They are characterisation tests, not endorsements — each one names the
 * problem. If any of these start failing because the source was fixed, delete the test and be
 * pleased about it.
 */
describe('documented quirks (characterisation, not endorsement)', () => {
  it('BUG: toInstant lands on the previous calendar day where local midnight is skipped by DST', () => {
    // Chile moves the clock forward at 24:00, so 2026-09-06 00:00 does not exist in Santiago.
    // The docstring on toInstant claims it "returns the first instant that does" — it does not.
    // It returns 23:00 on 2026-09-05 local, so fromInstant reports the wrong day and a
    // "renews on the 6th" reminder fires on the 5th for every Chilean user, every year.
    const date = D('2026-09-06');
    const instant = toInstant(date, 'America/Santiago');
    expect(instant.toISOString()).toBe('2026-09-06T03:00:00.000Z');
    expect(S(fromInstant(instant, 'America/Santiago'))).toBe('2026-09-05');
    expect(fromInstant(instant, 'America/Santiago')).not.toEqual(date);

    // Same failure in Brazil's historical DST, which also switched at midnight.
    const saoPaulo = D('1985-11-02');
    expect(S(fromInstant(toInstant(saoPaulo, 'America/Sao_Paulo'), 'America/Sao_Paulo'))).toBe('1985-11-01');
  });

  it('BUG: toInstant maps years 0..99 into 1900..1999 via legacy Date.UTC behaviour', () => {
    // plainDate happily accepts year 50 (the type is documented as proleptic Gregorian), but
    // Date.UTC(50, ...) means 1950, so the instant is off by 1900 years and the round trip fails
    // silently rather than throwing.
    const date = plainDate(50, 1, 2);
    expect(toInstant(date, 'UTC').toISOString()).toBe('1950-01-02T00:00:00.000Z');
    expect(fromInstant(toInstant(date, 'UTC'), 'UTC')).not.toEqual(date);
    expect(S(fromInstant(toInstant(plainDate(99, 6, 15), 'UTC'), 'UTC'))).toBe('1999-06-15');

    // Year 100 and above are handled correctly, which is what makes the cliff easy to miss.
    expect(toInstant(plainDate(100, 1, 2), 'UTC').toISOString()).toBe('0100-01-02T00:00:00.000Z');
  });

  it('QUIRK: formatPlainDate produces an unparseable string for a negative year', () => {
    // padStart pads the minus sign, so year -1 formats as "00-1" and the result cannot be read
    // back. plainDate does not reject negative years, so this is reachable from valid input.
    const date = plainDate(-1, 12, 31);
    expect(formatPlainDate(date)).toBe('00-1-12-31');
    expect(codeOf(catchError(() => parsePlainDate(formatPlainDate(date))))).toBe('INVALID_DATE');
  });

  it('QUIRK: addYears accepts a fractional year when years * 12 happens to be whole', () => {
    // addYears does no validation of its own; it delegates to addMonths, which only sees the
    // product. So "half a year" is silently accepted while "a tenth of a year" is not.
    expect(addYears(D('2026-01-15'), 0.5)).toEqual(D('2026-07-15'));
    expect(addYears(D('2026-01-15'), 0.25)).toEqual(D('2026-04-15'));
    expect(codeOf(catchError(() => addYears(D('2026-01-15'), 0.1)))).toBe('INVALID_ARGUMENT');
  });

  it('QUIRK: an unknown IANA zone escapes as a raw RangeError, not a LedgerError', () => {
    // Every other failure in this module carries a stable `code`; this one does not, so a caller
    // switching on LedgerErrorCode will not see it.
    const fromError = catchError(() => fromInstant(new Date(0), 'Not/AZone'));
    expect(fromError).toBeInstanceOf(RangeError);
    expect(fromError).not.toBeInstanceOf(LedgerError);

    const toError = catchError(() => toInstant(D('2026-01-01'), 'Not/AZone'));
    expect(toError).toBeInstanceOf(RangeError);
    expect(toError).not.toBeInstanceOf(LedgerError);
  });

  it('QUIRK: the same "month out of range" condition yields two different error codes', () => {
    // daysInMonth reports INVALID_ARGUMENT, plainDate reports INVALID_DATE, for month 13.
    expect(codeOf(catchError(() => daysInMonth(2026, 13)))).toBe('INVALID_ARGUMENT');
    expect(codeOf(catchError(() => plainDate(2026, 13, 1)))).toBe('INVALID_DATE');
  });

  it('QUIRK: the arithmetic helpers return unvalidated object literals, not plainDate results', () => {
    // Not a defect today — the clamp keeps them in range — but nothing enforces it, so any future
    // change to addMonths would go undetected. These assertions are the enforcement.
    for (const value of [addMonths(D('2026-01-31'), 1), startOfMonth(D('2026-01-31')), endOfMonth(D('2026-02-01'))]) {
      expect(plainDate(value.year, value.month, value.day)).toEqual(value);
    }
  });
});
