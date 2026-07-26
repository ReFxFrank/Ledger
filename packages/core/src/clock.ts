/**
 * Clock.
 *
 * Brief §11: "No `Date.now()` in testable code — inject a `Clock`."
 *
 * Every lead-time calculation, deadline, quiet-hours check, and cadence projection reads time
 * from here. That is what makes "the trial alert fires exactly 3 days before conversion" a test
 * that runs in a millisecond instead of a thing we hope is true.
 */

import { type PlainDate, fromInstant } from './plain-date';

export interface Clock {
  /** The current instant. */
  now(): Date;
  /** Milliseconds since the epoch. Convenience for durations. */
  epochMillis(): number;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  epochMillis(): number {
    return Date.now();
  }
}

/** A clock that only moves when a test tells it to. */
export class FixedClock implements Clock {
  private current: number;

  constructor(instant: Date | string | number) {
    this.current = toMillis(instant);
  }

  now(): Date {
    return new Date(this.current);
  }

  epochMillis(): number {
    return this.current;
  }

  setTo(instant: Date | string | number): void {
    this.current = toMillis(instant);
  }

  advanceMillis(millis: number): void {
    this.current += millis;
  }

  advanceDays(days: number): void {
    this.advanceMillis(days * 86_400_000);
  }

  advanceHours(hours: number): void {
    this.advanceMillis(hours * 3_600_000);
  }
}

function toMillis(instant: Date | string | number): number {
  if (instant instanceof Date) return instant.getTime();
  if (typeof instant === 'number') return instant;
  return new Date(instant).getTime();
}

/** The user's current calendar date. Timezone is explicit because renewals are wall-clock events. */
export function today(clock: Clock, timeZone = 'UTC'): PlainDate {
  return fromInstant(clock.now(), timeZone);
}

export const MILLIS_PER_SECOND = 1000;
export const MILLIS_PER_MINUTE = 60 * MILLIS_PER_SECOND;
export const MILLIS_PER_HOUR = 60 * MILLIS_PER_MINUTE;
export const MILLIS_PER_DAY = 24 * MILLIS_PER_HOUR;
