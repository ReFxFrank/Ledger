/**
 * The weekly digest — Sunday 18:00 local, and only when there is something to say.
 *
 * The rule that shapes this file is the second half of that sentence. An empty digest is worse
 * than no digest: it is a weekly reminder that the product has nothing for you, it trains the
 * reader to archive on sight, and by the week something *does* need attention the email has
 * already stopped being read. So `scheduleWeeklyDigest` returns null rather than an email saying
 * "no new subscriptions found", and that is tested.
 *
 * Pure, like `schedule.ts`: the caller supplies the week's detections and a clock.
 */

import {
  type Clock,
  addDays,
  dedupeKey,
  formatPlainDate,
  ignoresQuietHours,
} from '@ledger/core';
import { applyQuietHours } from './quiet-hours';
import { dayOfWeekOf, instantAtLocalMinute, localDate, localMinuteOfDay } from './local-time';
import { type UserNotificationPreferences, channelsFor } from './schedule';
import type { DetectionSummary, NotificationRequest } from './types';

export interface WeeklyDigestInput {
  /** Everything found since the last digest. Empty means no digest at all. */
  readonly detections: readonly DetectionSummary[];
}

/**
 * The next occurrence of the user's digest slot, strictly in the future.
 *
 * Exported because the worker wants to know when the next digest is due without building one,
 * and because "is this Sunday or next Sunday" is exactly the kind of arithmetic that deserves a
 * test of its own.
 */
export function nextDigestAt(prefs: UserNotificationPreferences, clock: Clock): Date {
  const now = clock.now();
  const today = localDate(now, prefs.timeZone);
  const nowMinute = localMinuteOfDay(now, prefs.timeZone);

  let daysAhead = (prefs.digestDayOfWeek - dayOfWeekOf(today) + 7) % 7;
  // Today's slot has already gone by; the digest is next week's, not one in the past.
  if (daysAhead === 0 && nowMinute >= prefs.digestMinute) daysAhead = 7;

  return instantAtLocalMinute(addDays(today, daysAhead), prefs.timeZone, prefs.digestMinute);
}

/** The local date the next digest lands on. This is the event date behind its dedupe key. */
export function nextDigestDate(
  prefs: UserNotificationPreferences,
  clock: Clock,
): ReturnType<typeof localDate> {
  return localDate(nextDigestAt(prefs, clock), prefs.timeZone);
}

/**
 * Builds the weekly digest, or returns null when there is nothing to say.
 *
 * The dedupe key is `new_detections : <user> : <digest date>`. The digest *date* rather than the
 * scheduled instant, so a scheduler that runs on Tuesday and again on Wednesday produces the same
 * key for the same upcoming Sunday and the second insert conflicts away — which is the whole
 * point of materialising the digest ahead of time rather than at send.
 */
export function scheduleWeeklyDigest(
  input: WeeklyDigestInput,
  prefs: UserNotificationPreferences,
  clock: Clock,
): NotificationRequest | null {
  if (input.detections.length === 0) return null;

  const channels = channelsFor(prefs, 'new_detections');
  if (channels.length === 0) return null;

  const scheduledFor = nextDigestAt(prefs, clock);
  const digestDate = localDate(scheduledFor, prefs.timeZone);

  const quiet = ignoresQuietHours('new_detections')
    ? { scheduledFor, deferredFrom: null }
    : applyQuietHours(scheduledFor, { ...prefs.quietHours, timeZone: prefs.timeZone }, clock);

  return {
    type: 'new_detections',
    userId: prefs.userId,
    dedupeKey: dedupeKey('new_detections', prefs.userId, formatPlainDate(digestDate)),
    scheduledFor: quiet.scheduledFor,
    deferredFrom: quiet.deferredFrom,
    channels,
    priority: 'normal',
    subscriptionId: null,
    payload: {
      weekOf: formatPlainDate(digestDate),
      items: input.detections,
    },
  };
}
