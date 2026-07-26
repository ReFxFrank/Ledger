/**
 * Wall-clock arithmetic in the user's own timezone.
 *
 * Every time-of-day in this package — quiet hours, the daily send minute, the Sunday digest — is
 * a *wall-clock* statement. "Don't wake me before 8am" is not 08:00 UTC and is not a fixed offset
 * from UTC: it has to survive the user flying to Tokyo, and it has to survive a DST transition
 * landing between the moment a notification was scheduled and the moment it comes due. So nothing
 * here caches an offset; every conversion re-resolves the zone at the instant in question.
 *
 * `@ledger/core` already has `toInstant`, and this duplicates its two-pass offset probe for one
 * reason: `toInstant` is hour-granular by design (a renewal is a calendar day, not an
 * appointment), and quiet hours are stored as minutes from midnight. Rounding a user's 22:30 down
 * to 22:00 would be a silent behaviour change in the one feature whose entire purpose is
 * respecting a boundary the user set.
 */

import { type PlainDate, addDays } from '@ledger/core';

export const MINUTES_PER_DAY = 1440;

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function localParts(instant: Date, timeZone: string): LocalParts {
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

  // Some ICU versions report midnight as hour 24 under hour12:false; normalise before it becomes
  // an off-by-one-day in a quiet-hours comparison.
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
  };
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = localParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  // `parts` drops seconds, so compare against the instant truncated to the minute.
  const truncated = Math.floor(instant.getTime() / 60_000) * 60_000;
  return asUtc - truncated;
}

/** The calendar date showing on the user's wall at `instant`. */
export function localDate(instant: Date, timeZone: string): PlainDate {
  const { year, month, day } = localParts(instant, timeZone);
  return { year, month, day };
}

/** Minutes since local midnight at `instant`. 08:30 → 510. */
export function localMinuteOfDay(instant: Date, timeZone: string): number {
  const { hour, minute } = localParts(instant, timeZone);
  return hour * 60 + minute;
}

/** 0 = Sunday … 6 = Saturday, in local terms rather than UTC. */
export function localDayOfWeek(instant: Date, timeZone: string): number {
  const date = localDate(instant, timeZone);
  return dayOfWeekOf(date);
}

/** Day of week for a calendar date. Integer arithmetic — 1970-01-01 was a Thursday. */
export function dayOfWeekOf(date: PlainDate): number {
  const epochDay = Math.floor(Date.UTC(date.year, date.month - 1, date.day) / 86_400_000);
  return (((epochDay + 4) % 7) + 7) % 7;
}

/**
 * The instant at which a given local minute of a given local day occurs.
 *
 * `minuteOfDay` may be ≥ 1440 or negative; it rolls into the neighbouring day. That is not a
 * convenience — a quiet-hours window that wraps midnight resolves its end boundary as "minute
 * 1920 of the day the notification landed on", and expressing that directly is less error-prone
 * than making every caller do the day arithmetic itself.
 *
 * Two passes converge for every real zone: the first corrects the base offset, the second
 * corrects the case where that correction itself crossed a DST boundary. On a spring-forward
 * morning where the requested local time does not exist, this lands on the first instant that
 * does — which is the behaviour "release at 08:00" wants.
 */
export function instantAtLocalMinute(date: PlainDate, timeZone: string, minuteOfDay: number): Date {
  const dayOffset = Math.floor(minuteOfDay / MINUTES_PER_DAY);
  const withinDay = minuteOfDay - dayOffset * MINUTES_PER_DAY;
  const target = dayOffset === 0 ? date : addDays(date, dayOffset);

  const naiveUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    Math.floor(withinDay / 60),
    withinDay % 60,
    0,
    0,
  );

  let instant = naiveUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    instant = naiveUtc - zoneOffsetMs(new Date(instant), timeZone);
  }
  return new Date(instant);
}

/** The last instant of a local day, used as the "is this still worth saying" horizon. */
export function endOfLocalDay(date: PlainDate, timeZone: string): Date {
  return new Date(instantAtLocalMinute(date, timeZone, MINUTES_PER_DAY).getTime() - 1);
}
