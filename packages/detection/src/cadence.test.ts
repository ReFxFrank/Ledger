/**
 * Cadence mechanics.
 *
 * These are the cases that decide whether the engine is trustworthy, so they are written as
 * date sequences a bank would actually emit rather than as synthetic arithmetic. The
 * calendar-monthly group is the important one: every assertion there fails if the interval is
 * ever approximated as 30 days.
 */

import { ANNUAL, MONTHLY, formatPlainDate, intervalsEqual, parsePlainDate } from '@ledger/core';
import { describe, expect, it } from 'vitest';

import { inferCadence, projectNextExpected } from './cadence';

const on = (iso: string) => parsePlainDate(iso);
const dates = (...isos: readonly string[]) => isos.map(on);

/** `unit×count`, so a failure message names the interval instead of dumping an object. */
function label(isos: readonly string[]): string {
  const fit = inferCadence(dates(...isos));
  return fit === null ? 'none' : `${fit.interval.unit}x${String(fit.interval.count)}`;
}

describe('inferCadence — fixed-length intervals', () => {
  it('separates weekly, fortnightly and four-weekly', () => {
    expect(label(['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'])).toBe('weekx1');
    expect(label(['2026-01-05', '2026-01-19', '2026-02-02', '2026-02-16'])).toBe('weekx2');
    expect(label(['2026-01-05', '2026-02-02', '2026-03-02', '2026-03-30'])).toBe('weekx4');
  });

  it('does not read a fortnightly series as weekly with every other week missed', () => {
    const fit = inferCadence(dates('2026-01-05', '2026-01-19', '2026-02-02'));
    expect(fit?.missedPeriods).toBe(0);
    expect(intervalsEqual(fit?.interval ?? MONTHLY, { unit: 'week', count: 2 })).toBe(true);
  });

  it('reads 90/91/92-day gaps as quarterly and 365-day gaps as annual', () => {
    expect(label(['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15'])).toBe('monthx3');
    expect(label(['2024-03-01', '2025-03-01', '2026-03-01'])).toBe('yearx1');
  });

  it('survives a leap day in an annual series', () => {
    const fit = inferCadence(dates('2024-02-29', '2025-02-28', '2026-02-28'));
    expect(intervalsEqual(fit?.interval ?? MONTHLY, ANNUAL)).toBe(true);
    expect(fit?.jitterScore).toBe(1);
  });
});

describe('inferCadence — calendar-monthly is not 30 days', () => {
  it('reads month-end clamping as monthly with no jitter at all', () => {
    // 28, 31, 30 day gaps. A fixed-length comparison calls this irregular; a card issuer calls
    // it the 31st of every month.
    const fit = inferCadence(dates('2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'));
    expect(intervalsEqual(fit?.interval ?? ANNUAL, MONTHLY)).toBe(true);
    expect(fit?.jitterScore).toBe(1);
    expect(fit?.gapDays).toEqual([28, 31, 30]);
  });

  it('anchors on the charge that reveals the month-end, not on the earliest one', () => {
    // Seen from Feb 28 the series looks like three days of drift; only the Mar 31 charge shows
    // that the anchor day-of-month is 31.
    const fit = inferCadence(dates('2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'));
    expect(formatPlainDate(fit?.anchor ?? on('1970-01-01'))).toBe('2026-03-31');
    expect(fit?.jitterScore).toBe(1);
  });

  it('prefers monthly over four-weekly at a 30-day gap, and four-weekly at 28', () => {
    expect(label(['2026-01-15', '2026-02-14'])).toBe('monthx1');
    expect(label(['2026-01-15', '2026-02-12'])).toBe('weekx4');
  });
});

describe('inferCadence — jitter tolerance', () => {
  it('accepts a monthly charge three days either side of the anchor', () => {
    const fit = inferCadence(dates('2026-01-10', '2026-02-13', '2026-03-08', '2026-04-11'));
    expect(intervalsEqual(fit?.interval ?? ANNUAL, MONTHLY)).toBe(true);
    expect(fit?.matchedIndices).toEqual([0, 1, 2, 3]);
    expect(fit?.jitterScore).toBeCloseTo(1 - 2 / 3, 5);
  });

  it('scores a perfectly punctual series at 1', () => {
    const fit = inferCadence(dates('2026-01-15', '2026-02-15', '2026-03-15'));
    expect(fit?.jitterScore).toBe(1);
  });
});

describe('inferCadence — gaps and breaks', () => {
  it('treats one skipped cycle as a gap and keeps the run together', () => {
    const fit = inferCadence(dates('2026-01-10', '2026-02-10', '2026-04-10', '2026-05-10'));
    expect(fit?.matchedIndices).toEqual([0, 1, 2, 3]);
    expect(fit?.missedPeriods).toBe(1);
    expect(fit?.gapDays).toEqual([31, 59, 30]);
  });

  it('ends the run after two consecutive misses and keeps the longer side', () => {
    const fit = inferCadence(
      dates('2026-01-10', '2026-02-10', '2026-05-10', '2026-06-10', '2026-07-10'),
    );
    expect(fit?.matchedIndices).toEqual([2, 3, 4]);
    expect(fit?.missedPeriods).toBe(0);
  });

  it('steps over a one-off charge without truncating the subscription', () => {
    // Someone bought something from a merchant they also subscribe to. The extra charge is not
    // part of the cadence and must not end it.
    const fit = inferCadence(dates('2026-01-10', '2026-01-22', '2026-02-10', '2026-03-10'));
    expect(fit?.matchedIndices).toEqual([0, 2, 3]);
    expect(fit?.jitterScore).toBe(1);
  });

  it('drops a trial charge that sits at a different phase', () => {
    const fit = inferCadence(dates('2026-01-01', '2026-01-15', '2026-02-15', '2026-03-15'));
    expect(fit?.matchedIndices).toEqual([1, 2, 3]);
  });
});

describe('inferCadence — refusals', () => {
  it('returns null for fewer than two dates', () => {
    expect(inferCadence([])).toBeNull();
    expect(inferCadence(dates('2026-01-15'))).toBeNull();
  });

  it('returns null when two dates match no candidate interval', () => {
    expect(inferCadence(dates('2026-01-05', '2026-01-09'))).toBeNull();
  });

  it('accepts unsorted input and reports indices in the caller ordering', () => {
    const fit = inferCadence(dates('2026-03-15', '2026-01-15', '2026-02-15'));
    expect(fit?.matchedIndices).toEqual([0, 1, 2]);
    expect(formatPlainDate(fit?.anchor ?? on('1970-01-01'))).toBe('2026-01-15');
  });

  it('honours an explicit tolerance override', () => {
    const drifting = dates('2026-01-10', '2026-02-15', '2026-03-16');
    expect(inferCadence(drifting)?.interval.unit).not.toBe('month');
    expect(inferCadence(drifting, { toleranceDays: 6 })?.interval.unit).toBe('month');
  });
});

describe('projectNextExpected', () => {
  const next = (anchor: string, lastSeen: string, today: string) =>
    formatPlainDate(projectNextExpected(on(anchor), MONTHLY, on(lastSeen), on(today)));

  it('projects from the anchor so month-end survives', () => {
    // Stepping a month on from `lastSeen` would give Mar 28 and stay wrong forever after.
    expect(next('2026-01-31', '2026-02-28', '2026-03-01')).toBe('2026-03-31');
  });

  it('returns today when a charge is due today but has not posted', () => {
    expect(next('2026-01-15', '2026-02-15', '2026-03-15')).toBe('2026-03-15');
  });

  it('keeps projecting forward for a series that stopped', () => {
    // The candidate is reported as lapsed; the date still has to be a real future one, because
    // a renewal calendar cannot render a projection in the past.
    expect(next('2025-06-20', '2025-08-20', '2026-01-05')).toBe('2026-01-20');
  });

  it('never returns a date already charged, even if today is behind the data', () => {
    // A backfill can post charges dated after `today`. The next expected charge is still the one
    // after the last one seen, not a date the user has already been billed for.
    expect(next('2026-05-10', '2026-05-10', '2026-01-01')).toBe('2026-06-10');
  });
});
