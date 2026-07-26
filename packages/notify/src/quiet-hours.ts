/**
 * Quiet hours.
 *
 * Stored as local minutes-from-midnight plus an IANA timezone rather than as a pair of instants,
 * because "don't wake me before 8am" is a wall-clock statement. Stored as instants it would be
 * wrong the first time the user flew somewhere and wrong twice a year at home; stored as an
 * offset it would be wrong every DST transition. Stored as minutes plus a zone, it is right by
 * construction and the only work left is resolving it at the instant in question — which is what
 * `local-time.ts` does.
 *
 * Two behaviours carry this file:
 *
 * 1. **The window may wrap midnight.** 22:00–08:00 is the default and it is the case that breaks
 *    a naive `start <= t && t < end`. Handled explicitly rather than by normalising into two
 *    windows, because the wrapping case also decides *which local day* the end boundary is on.
 * 2. **`charged_after_cancellation` bypasses the whole thing.** That is not a special case
 *    threaded through here — `ignoresQuietHours()` lives in `@ledger/core` alongside the type
 *    union, so the exemption is a property of the notification type rather than a condition some
 *    caller might forget to write.
 */

import { type Clock, InvalidArgumentError } from '@ledger/core';
import { MINUTES_PER_DAY, instantAtLocalMinute, localDate, localMinuteOfDay } from './local-time';

/** The window itself, as stored on `notification_settings`. */
export interface QuietHoursWindow {
  readonly enabled: boolean;
  /** Local minutes from midnight. Default 1320 = 22:00. */
  readonly startMinute: number;
  /** Local minutes from midnight. Default 480 = 08:00. */
  readonly endMinute: number;
}

/** The window plus the zone it is expressed in. Both are needed to resolve a real instant. */
export interface QuietHoursSettings extends QuietHoursWindow {
  readonly timeZone: string;
}

export interface QuietHoursDecision {
  /** When to actually deliver. */
  readonly scheduledFor: Date;
  /** The original instant, when quiet hours moved it. Null when nothing was deferred. */
  readonly deferredFrom: Date | null;
}

export const DEFAULT_QUIET_HOURS: QuietHoursWindow = {
  enabled: true,
  startMinute: 22 * 60,
  endMinute: 8 * 60,
};

function assertMinute(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= MINUTES_PER_DAY) {
    throw new InvalidArgumentError(
      `${label} must be an integer minute of the day (0–1439), got ${String(value)}.`,
    );
  }
}

/**
 * True when `minute` falls inside the window.
 *
 * A window whose start equals its end is treated as *off*, not as "all day". Someone who sets
 * both ends to 08:00 has expressed an empty preference, and reading it as a 24-hour blackout
 * would silently stop every notification they ever get.
 */
export function isWithinQuietHours(minute: number, window: QuietHoursWindow): boolean {
  if (!window.enabled) return false;
  if (window.startMinute === window.endMinute) return false;
  return window.startMinute < window.endMinute
    ? minute >= window.startMinute && minute < window.endMinute
    : minute >= window.startMinute || minute < window.endMinute;
}

/**
 * Defers `scheduledFor` out of the user's quiet hours, or leaves it alone.
 *
 * The clock is here for one reason: the end boundary is resolved as a wall-clock minute, and on a
 * DST fall-back morning that minute exists twice while on a spring-forward morning it may not
 * exist at all. `instantAtLocalMinute` picks the first instant that satisfies it, and the clock
 * then guarantees the result is never handed back in the past — a notification deferred to an
 * instant that has already gone would be delivered immediately by the sender, defeating the
 * deferral it just performed.
 */
export function applyQuietHours(
  scheduledFor: Date,
  settings: QuietHoursSettings,
  clock: Clock,
): QuietHoursDecision {
  assertMinute(settings.startMinute, 'quietHoursStartMinute');
  assertMinute(settings.endMinute, 'quietHoursEndMinute');

  const minute = localMinuteOfDay(scheduledFor, settings.timeZone);
  if (!isWithinQuietHours(minute, settings)) {
    return { scheduledFor, deferredFrom: null };
  }

  const day = localDate(scheduledFor, settings.timeZone);
  const wraps = settings.startMinute > settings.endMinute;

  // For a wrapping window, an instant at or after the start belongs to *tonight* and its release
  // is tomorrow morning; an instant before the end is the tail of last night and its release is
  // this morning. Expressed as a minute offset so the day arithmetic happens in one place.
  const releaseMinute =
    wraps && minute >= settings.startMinute
      ? settings.endMinute + MINUTES_PER_DAY
      : settings.endMinute;

  const release = instantAtLocalMinute(day, settings.timeZone, releaseMinute);
  const now = clock.now();
  const target = release.getTime() < now.getTime() ? now : release;

  // A release that resolved to the same instant is not a deferral, and recording it as one would
  // make the UI apologise for a delay that never happened.
  if (target.getTime() === scheduledFor.getTime()) {
    return { scheduledFor, deferredFrom: null };
  }
  return { scheduledFor: target, deferredFrom: scheduledFor };
}
