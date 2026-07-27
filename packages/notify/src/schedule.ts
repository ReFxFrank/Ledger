/**
 * Scheduling — what to tell a user, and when.
 *
 * Pure by construction. No database, no network, no `Date.now()`: time arrives as a `Clock` and
 * everything else arrives as an argument. That is not tidiness for its own sake — "the trial
 * alert fires exactly three days before conversion, at 09:00 in the user's own timezone, unless
 * that lands in their quiet hours" is a sentence with four independent ways to be wrong, and the
 * only way to hold all four still is to be able to run them on a frozen clock.
 *
 * The invariant that matters most in this file is the **dedupe key**. `notifications.dedupe_key`
 * is UNIQUE, and that constraint is the mechanism behind "a user must never be told the same
 * thing twice" (brief §8). The scheduler is a repeatable job: it re-derives every due
 * notification on every run, and relies on the insert conflicting to drop the ones already sent.
 * For that to work the key has to be a function of the *subject* and the *event date* only —
 * never of `now`, never of the computed send time, never of anything that shifts when the worker
 * restarts, when a quiet-hours window defers delivery, or when two workers race a few
 * milliseconds apart. Every key built here is `type : subject : event-date [: variant]`, and the
 * variant is a fixed label like `d7`, not a countdown.
 */

import {
  type Clock,
  DEFAULT_LEAD_TIME_DAYS,
  type Money,
  type NotificationChannel,
  type NotificationType,
  type PlainDate,
  addDays,
  annualEquivalent,
  compare,
  daysBetween,
  dedupeKey,
  formatPlainDate,
  ignoresQuietHours,
  maxDate,
  money,
  relativeChangeBps,
  subtract,
} from '@ledger/core';
import { type QuietHoursWindow, DEFAULT_QUIET_HOURS, applyQuietHours } from './quiet-hours';
import { endOfLocalDay, instantAtLocalMinute, localDate } from './local-time';
import type {
  ChargedAfterCancellationPayload,
  DuplicateDetectedPayload,
  NotificationRequest,
  NotificationRequestBase,
  SubscriptionRef,
} from './types';

// ── preferences ────────────────────────────────────────────────────────────────────────

export interface TypePreference {
  /** Empty means this type is off entirely — no request is produced at all. */
  readonly channels: readonly NotificationChannel[];
  /** null falls back to `DEFAULT_LEAD_TIME_DAYS` for the type. */
  readonly leadTimeDays: number | null;
}

/**
 * Everything about the reader that scheduling depends on, decoupled from the DB rows so this
 * file stays testable without one. A worker assembles this from `notification_settings`,
 * `notification_preferences` and the user's timezone.
 */
export interface UserNotificationPreferences {
  readonly userId: string;
  /** IANA zone. Every date in every payload is resolved against it. */
  readonly timeZone: string;
  /** Local minute of day at which lead-time notifications are delivered. 540 = 09:00. */
  readonly sendMinute: number;
  readonly quietHours: QuietHoursWindow;
  /**
   * Below this, a renewal is not worth an email. Carries its currency so the comparison can
   * refuse rather than guess when the subscription is billed in a different one.
   */
  readonly renewalAlertThreshold: Money;
  /** 0 = Sunday. */
  readonly digestDayOfWeek: number;
  /** Local minute of day for the digest. 1080 = 18:00. */
  readonly digestMinute: number;
  readonly byType: Readonly<Partial<Record<NotificationType, TypePreference>>>;
}

/** What a user gets before they have touched a single setting. */
export const DEFAULT_CHANNELS: Readonly<Record<NotificationType, readonly NotificationChannel[]>> = {
  trial_ending: ['email', 'in_app'],
  renewal_upcoming: ['email', 'in_app'],
  price_changed: ['email', 'in_app'],
  cancel_by_deadline: ['email', 'push', 'in_app'],
  cancellation_unconfirmed: ['email', 'in_app'],
  // The one that may wake you. Push is on by default precisely because it is time-sensitive.
  charged_after_cancellation: ['email', 'push', 'in_app'],
  new_detections: ['email', 'in_app'],
  sync_failed: ['email', 'in_app'],
  consent_expiring: ['email', 'in_app'],
  duplicate_detected: ['in_app'],
};

export const DEFAULT_SEND_MINUTE = 9 * 60;
export const DEFAULT_DIGEST_MINUTE = 18 * 60;
export const DEFAULT_DIGEST_DAY_OF_WEEK = 0;

export interface DefaultPreferenceOverrides {
  readonly sendMinute?: number;
  readonly quietHours?: QuietHoursWindow;
  readonly renewalAlertThreshold?: Money;
  readonly digestDayOfWeek?: number;
  readonly digestMinute?: number;
  readonly byType?: Readonly<Partial<Record<NotificationType, TypePreference>>>;
}

export function defaultPreferences(
  userId: string,
  timeZone: string,
  currency = 'GBP',
  overrides: DefaultPreferenceOverrides = {},
): UserNotificationPreferences {
  return {
    userId,
    timeZone,
    sendMinute: overrides.sendMinute ?? DEFAULT_SEND_MINUTE,
    quietHours: overrides.quietHours ?? DEFAULT_QUIET_HOURS,
    // 2000 minor units matches the `notification_settings` column default.
    renewalAlertThreshold: overrides.renewalAlertThreshold ?? money(2000, currency),
    digestDayOfWeek: overrides.digestDayOfWeek ?? DEFAULT_DIGEST_DAY_OF_WEEK,
    digestMinute: overrides.digestMinute ?? DEFAULT_DIGEST_MINUTE,
    byType: overrides.byType ?? {},
  };
}

export function channelsFor(
  prefs: UserNotificationPreferences,
  type: NotificationType,
): readonly NotificationChannel[] {
  return prefs.byType[type]?.channels ?? DEFAULT_CHANNELS[type];
}

export function leadTimeDaysFor(
  prefs: UserNotificationPreferences,
  type: NotificationType,
): number {
  return prefs.byType[type]?.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS[type];
}

// ── the shared builder ─────────────────────────────────────────────────────────────────

/**
 * `immediate` fires as soon as the scheduler sees it; `lead` fires a fixed number of days before
 * the event, at the user's send minute. A negative lead is a trailing notification — the
 * unconfirmed-cancellation nudge is `lead: -3`, three days *after* the deadline.
 */
type Timing = { readonly kind: 'immediate' } | { readonly kind: 'lead'; readonly days: number };

/**
 * How late a lead-time notification may be delivered before it stops being worth sending.
 *
 * A worker that was down overnight should still deliver yesterday's reminders; a subscription
 * imported today whose trial ended last March should not produce an email announcing that the
 * trial ends in three days. One day of grace separates those two cases.
 */
export const LATE_DELIVERY_GRACE_DAYS = 1;

interface PlanInput {
  readonly type: NotificationType;
  readonly prefs: UserNotificationPreferences;
  readonly clock: Clock;
  /** The wall-clock date the notification is *about*. The dedupe key is built from this. */
  readonly eventDate: PlainDate;
  readonly timing: Timing;
  /** Stable id of the thing the notification concerns — subscription, connection, charge. */
  readonly subjectId: string;
  /** Distinguishes several alerts about one event, e.g. the 7-day and 1-day deadline calls. */
  readonly variant: string | null;
  readonly subscriptionId: string | null;
}

/**
 * Resolves timing, quiet hours, channels and the dedupe key. Returns null when the notification
 * should not exist: the type is switched off, or it is simply too late to be useful.
 *
 * Callers attach `type` and `payload` themselves so the resulting object literal lands in the
 * discriminated union with its payload checked against its type.
 */
function planRequest(input: PlanInput): NotificationRequestBase | null {
  const { prefs, clock, type } = input;

  const channels = channelsFor(prefs, type);
  if (channels.length === 0) return null;

  const priority = type === 'charged_after_cancellation' ? 'high' : 'normal';
  const now = clock.now();

  // The key is derived here, before any timing decision, so that nothing downstream — clamping,
  // quiet hours, a retry on a different day — can change it.
  const key = dedupeKey(type, input.subjectId, formatPlainDate(input.eventDate), input.variant);

  let target: Date;
  if (input.timing.kind === 'immediate') {
    target = now;
  } else {
    const sendDate = addDays(input.eventDate, -input.timing.days);
    const ideal = instantAtLocalMinute(sendDate, prefs.timeZone, prefs.sendMinute);

    if (ideal.getTime() >= now.getTime()) {
      target = ideal;
    } else {
      // We are late. Send now if the fact is still live, drop it if the moment has passed.
      const horizon = endOfLocalDay(
        addDays(maxDate(input.eventDate, sendDate), LATE_DELIVERY_GRACE_DAYS),
        prefs.timeZone,
      );
      if (now.getTime() > horizon.getTime()) return null;
      target = now;
    }
  }

  const quiet = ignoresQuietHours(type)
    ? { scheduledFor: target, deferredFrom: null }
    : applyQuietHours(target, { ...prefs.quietHours, timeZone: prefs.timeZone }, clock);

  return {
    userId: prefs.userId,
    dedupeKey: key,
    scheduledFor: quiet.scheduledFor,
    deferredFrom: quiet.deferredFrom,
    channels,
    priority,
    subscriptionId: input.subscriptionId,
  };
}

// ── trial_ending ───────────────────────────────────────────────────────────────────────

export interface TrialEndingInput {
  readonly subscription: SubscriptionRef;
  /** The instant the trial converts, as stored on `subscriptions.trial_ends_at`. */
  readonly trialEndsAt: Date;
}

/**
 * Three days before the trial converts, by default.
 *
 * The event date is the trial-end *local day*, not the instant: a trial ending at 23:40 UTC is,
 * for a user in Auckland, ending tomorrow, and the reminder that says "in three days" has to
 * count in the days the user is living in.
 */
export function scheduleTrialEnding(
  input: TrialEndingInput,
  prefs: UserNotificationPreferences,
  clock: Clock,
): NotificationRequest[] {
  const trialEndsOn = localDate(input.trialEndsAt, prefs.timeZone);
  const leadTimeDays = leadTimeDaysFor(prefs, 'trial_ending');

  const plan = planRequest({
    type: 'trial_ending',
    prefs,
    clock,
    eventDate: trialEndsOn,
    timing: { kind: 'lead', days: leadTimeDays },
    subjectId: input.subscription.subscriptionId,
    variant: null,
    subscriptionId: input.subscription.subscriptionId,
  });
  if (plan === null) return [];

  return [
    {
      ...plan,
      type: 'trial_ending',
      payload: {
        subscription: input.subscription,
        trialEndsOn: formatPlainDate(trialEndsOn),
        leadTimeDays,
      },
    },
  ];
}

// ── renewal_upcoming ───────────────────────────────────────────────────────────────────

export interface RenewalUpcomingInput {
  readonly subscription: SubscriptionRef;
  readonly renewsAt: Date;
  /**
   * The per-subscription opt-in. `null` means the user has not expressed a preference for this
   * subscription, and the amount decides.
   */
  readonly alertOptIn: boolean | null;
}

/**
 * Two days before a renewal, opt-in per subscription, on by default above the user's threshold.
 *
 * When the subscription is billed in a currency other than the threshold's, the comparison is
 * refused and the alert defaults **on**. Converting here would mean carrying an FX table into a
 * pure scheduling module, and guessing would mean silently suppressing a renewal alert for every
 * foreign-currency subscription a user has — the failure mode where nothing appears to be wrong.
 */
export function scheduleRenewalUpcoming(
  input: RenewalUpcomingInput,
  prefs: UserNotificationPreferences,
  clock: Clock,
): NotificationRequest[] {
  if (!isRenewalAlertOn(input, prefs)) return [];

  const renewsOn = localDate(input.renewsAt, prefs.timeZone);
  const leadTimeDays = leadTimeDaysFor(prefs, 'renewal_upcoming');

  const plan = planRequest({
    type: 'renewal_upcoming',
    prefs,
    clock,
    eventDate: renewsOn,
    timing: { kind: 'lead', days: leadTimeDays },
    subjectId: input.subscription.subscriptionId,
    variant: null,
    subscriptionId: input.subscription.subscriptionId,
  });
  if (plan === null) return [];

  return [
    {
      ...plan,
      type: 'renewal_upcoming',
      payload: {
        subscription: input.subscription,
        renewsOn: formatPlainDate(renewsOn),
        leadTimeDays,
      },
    },
  ];
}

function isRenewalAlertOn(
  input: RenewalUpcomingInput,
  prefs: UserNotificationPreferences,
): boolean {
  if (input.alertOptIn !== null) return input.alertOptIn;
  const threshold = prefs.renewalAlertThreshold;
  const amount = input.subscription.amount;
  if (amount.currency !== threshold.currency) return true;
  return compare(amount, threshold) >= 0;
}

// ── price_changed ──────────────────────────────────────────────────────────────────────

/**
 * Below this, a "price change" is a rounding artifact, a partial-month proration, or a currency
 * conversion wobble — not news. Matches the detection threshold in brief §4.4.
 */
export const PRICE_CHANGE_ALERT_THRESHOLD_BPS = 300;

export interface PriceChangedInput {
  readonly subscription: SubscriptionRef;
  readonly previousAmount: Money;
  readonly newAmount: Money;
  /** The date the new amount takes effect. Also the event date behind the dedupe key. */
  readonly effectiveFrom: PlainDate;
}

/**
 * One alert per price change, stating the annualized difference.
 *
 * Exactly one: the dedupe key is `price_changed : <subscription> : <effective date>` and
 * deliberately does not include the new amount. Including it would look more precise and would
 * be worse — a detector that re-reported the same change with a corrected figure would produce a
 * second email about one price rise, which is the thing this key exists to prevent.
 *
 * The number the email leads with is `newAnnual − previousAnnual`, computed with
 * `annualEquivalent` so the cadence is handled exactly: 9.99 → 12.99 monthly is £36.00 a year,
 * and 4-weekly would be thirteen charges rather than twelve.
 */
export function schedulePriceChanged(
  input: PriceChangedInput,
  prefs: UserNotificationPreferences,
  clock: Clock,
): NotificationRequest[] {
  // Mixed currencies here mean the subscription was re-denominated, not re-priced; there is no
  // honest delta to state, so nothing is sent rather than something wrong.
  if (input.previousAmount.currency !== input.newAmount.currency) return [];

  const deltaBps = relativeChangeBps(input.previousAmount, input.newAmount);
  if (deltaBps !== null && Math.abs(deltaBps) < PRICE_CHANGE_ALERT_THRESHOLD_BPS) return [];

  const interval = input.subscription.interval;
  const previousAnnual = annualEquivalent(input.previousAmount, interval);
  const newAnnual = annualEquivalent(input.newAmount, interval);

  const plan = planRequest({
    type: 'price_changed',
    prefs,
    clock,
    eventDate: input.effectiveFrom,
    timing: { kind: 'immediate' },
    subjectId: input.subscription.subscriptionId,
    variant: null,
    subscriptionId: input.subscription.subscriptionId,
  });
  if (plan === null) return [];

  return [
    {
      ...plan,
      type: 'price_changed',
      payload: {
        subscription: input.subscription,
        previousAmount: input.previousAmount,
        newAmount: input.newAmount,
        previousAnnual,
        newAnnual,
        annualDelta: subtract(newAnnual, previousAnnual),
        deltaBps,
        effectiveFrom: formatPlainDate(input.effectiveFrom),
      },
    },
  ];
}

// ── cancel_by_deadline ─────────────────────────────────────────────────────────────────

/**
 * Two calls: one with a week to act, one on the eve.
 *
 * The 7-day figure is the user's configurable lead; the 1-day call is not configurable, because
 * a cancel-by deadline missed by a day costs a full billing period and the last reminder is the
 * one that actually catches people.
 */
export const CANCEL_BY_FINAL_LEAD_DAYS = 1;

export interface CancelByDeadlineInput {
  readonly subscription: SubscriptionRef;
  readonly cancellationRequestId: string | null;
  /** `subscriptions.cancel_by_at` — next renewal minus the notice period. */
  readonly deadlineAt: Date;
}

export function scheduleCancelByDeadline(
  input: CancelByDeadlineInput,
  prefs: UserNotificationPreferences,
  clock: Clock,
): NotificationRequest[] {
  const deadlineOn = localDate(input.deadlineAt, prefs.timeZone);
  const configured = leadTimeDaysFor(prefs, 'cancel_by_deadline');

  const leads = [...new Set([configured, CANCEL_BY_FINAL_LEAD_DAYS])]
    .filter((days) => days > 0)
    .sort((a, b) => b - a);

  const requests: NotificationRequest[] = [];
  for (const days of leads) {
    const plan = planRequest({
      type: 'cancel_by_deadline',
      prefs,
      clock,
      eventDate: deadlineOn,
      timing: { kind: 'lead', days },
      subjectId: input.subscription.subscriptionId,
      // A fixed label, not a countdown: `d7` means "the seven-day call about this deadline" and
      // reads the same on every run, which is what keeps the two alerts distinct but each unique.
      variant: `d${String(days)}`,
      subscriptionId: input.subscription.subscriptionId,
    });
    if (plan === null) continue;

    requests.push({
      ...plan,
      type: 'cancel_by_deadline',
      payload: {
        subscription: input.subscription,
        cancellationRequestId: input.cancellationRequestId,
        deadlineOn: formatPlainDate(deadlineOn),
        leadTimeDays: days,
      },
    });
  }
  return requests;
}

// ── cancellation_unconfirmed ───────────────────────────────────────────────────────────

export interface CancellationUnconfirmedInput {
  readonly subscription: SubscriptionRef;
  readonly cancellationRequestId: string;
  readonly deadlineAt: Date;
}

/**
 * Three days past the deadline with no confirmation recorded.
 *
 * A trailing lead — negative days — because the event is the deadline and the notification comes
 * after it. Keyed on the deadline rather than on the day the nudge goes out, so a scheduler that
 * runs twice, or runs a day late, still produces one nudge.
 */
export function scheduleCancellationUnconfirmed(
  input: CancellationUnconfirmedInput,
  prefs: UserNotificationPreferences,
  clock: Clock,
): NotificationRequest[] {
  const deadlineOn = localDate(input.deadlineAt, prefs.timeZone);
  const trailingDays = leadTimeDaysFor(prefs, 'cancellation_unconfirmed');

  const plan = planRequest({
    type: 'cancellation_unconfirmed',
    prefs,
    clock,
    eventDate: deadlineOn,
    timing: { kind: 'lead', days: -trailingDays },
    subjectId: input.cancellationRequestId,
    variant: null,
    subscriptionId: input.subscription.subscriptionId,
  });
  if (plan === null) return [];

  return [
    {
      ...plan,
      type: 'cancellation_unconfirmed',
      payload: {
        subscription: input.subscription,
        cancellationRequestId: input.cancellationRequestId,
        deadlineOn: formatPlainDate(deadlineOn),
        daysSinceDeadline: trailingDays,
      },
    },
  ];
}

// ── charged_after_cancellation ─────────────────────────────────────────────────────────

export interface ChargedAfterCancellationInput {
  readonly subscription: SubscriptionRef;
  readonly cancellationRequestId: string | null;
  /** The charge that should not have happened. Also the subject of the dedupe key. */
  readonly transactionId: string;
  readonly merchantName: string;
  readonly amount: Money;
  readonly chargedAt: Date;
  readonly cancelledAt: Date;
  readonly confirmationReference: string | null;
  readonly evidenceCount: number;
}

/**
 * Immediate, high priority, and the only notification that ignores quiet hours.
 *
 * The exemption is not applied here — `ignoresQuietHours()` in `@ledger/core` owns it, so it is a
 * property of the type rather than a condition this function could forget. Being charged after
 * you cancelled is time-sensitive in a way a renewal reminder is not: card-scheme dispute windows
 * are short and start running from the charge, not from when the user noticed.
 *
 * Keyed on the transaction, so a second unexpected charge is a second alert — which it should be.
 */
export function scheduleChargedAfterCancellation(
  input: ChargedAfterCancellationInput,
  prefs: UserNotificationPreferences,
  clock: Clock,
): NotificationRequest[] {
  const chargedOn = localDate(input.chargedAt, prefs.timeZone);

  const plan = planRequest({
    type: 'charged_after_cancellation',
    prefs,
    clock,
    eventDate: chargedOn,
    timing: { kind: 'immediate' },
    subjectId: input.transactionId,
    variant: null,
    subscriptionId: input.subscription.subscriptionId,
  });
  if (plan === null) return [];

  const payload: ChargedAfterCancellationPayload = {
    subscription: input.subscription,
    cancellationRequestId: input.cancellationRequestId,
    transactionId: input.transactionId,
    merchantName: input.merchantName,
    amount: input.amount,
    chargedOn: formatPlainDate(chargedOn),
    cancelledOn: formatPlainDate(localDate(input.cancelledAt, prefs.timeZone)),
    confirmationReference: input.confirmationReference,
    evidenceCount: input.evidenceCount,
  };

  return [{ ...plan, type: 'charged_after_cancellation', payload }];
}

// ── sync_failed ────────────────────────────────────────────────────────────────────────

export interface SyncFailedInput {
  readonly connectionId: string;
  readonly institutionName: string;
  /**
   * The instant the *current* failing run started — not the instant of the latest failure.
   * A connection that has been broken for a week is one problem, and keying on the run start is
   * what stops it becoming seven identical emails.
   */
  readonly failingSince: Date;
}

export function scheduleSyncFailed(
  input: SyncFailedInput,
  prefs: UserNotificationPreferences,
  clock: Clock,
): NotificationRequest[] {
  const failingSince = localDate(input.failingSince, prefs.timeZone);

  const plan = planRequest({
    type: 'sync_failed',
    prefs,
    clock,
    eventDate: failingSince,
    timing: { kind: 'immediate' },
    subjectId: input.connectionId,
    variant: null,
    subscriptionId: null,
  });
  if (plan === null) return [];

  return [
    {
      ...plan,
      type: 'sync_failed',
      payload: {
        connectionId: input.connectionId,
        institutionName: input.institutionName,
        failingSince: formatPlainDate(failingSince),
      },
    },
  ];
}

// ── consent_expiring ───────────────────────────────────────────────────────────────────

export interface ConsentExpiringInput {
  readonly connectionId: string;
  readonly institutionName: string;
  readonly expiresAt: Date;
}

/**
 * Fourteen days before open-banking consent lapses.
 *
 * Long lead because re-consenting means a trip through the bank's own app, and a user who finds
 * out on the day loses their transaction feed until they get round to it.
 */
export function scheduleConsentExpiring(
  input: ConsentExpiringInput,
  prefs: UserNotificationPreferences,
  clock: Clock,
): NotificationRequest[] {
  const expiresOn = localDate(input.expiresAt, prefs.timeZone);
  const leadTimeDays = leadTimeDaysFor(prefs, 'consent_expiring');

  const plan = planRequest({
    type: 'consent_expiring',
    prefs,
    clock,
    eventDate: expiresOn,
    timing: { kind: 'lead', days: leadTimeDays },
    subjectId: input.connectionId,
    variant: null,
    subscriptionId: null,
  });
  if (plan === null) return [];

  return [
    {
      ...plan,
      type: 'consent_expiring',
      payload: {
        connectionId: input.connectionId,
        institutionName: input.institutionName,
        expiresOn: formatPlainDate(expiresOn),
        leadTimeDays,
      },
    },
  ];
}

// ── duplicate_detected ─────────────────────────────────────────────────────────────────

export interface DuplicateDetectedInput {
  /** Two or more subscriptions that look like the same service. Order is not significant. */
  readonly subscriptions: readonly SubscriptionRef[];
  /** The day the overlap was observed. */
  readonly observedAt: Date;
}

/**
 * Keyed on the *set* of subscriptions, sorted, so the same overlap reported by two detector runs
 * in either order collapses to one notification.
 */
export function scheduleDuplicateDetected(
  input: DuplicateDetectedInput,
  prefs: UserNotificationPreferences,
  clock: Clock,
): NotificationRequest[] {
  if (input.subscriptions.length < 2) return [];

  const ids = input.subscriptions.map((s) => s.subscriptionId).sort((a, b) => a.localeCompare(b));
  const first = input.subscriptions[0];
  if (first === undefined) return [];

  const plan = planRequest({
    type: 'duplicate_detected',
    prefs,
    clock,
    eventDate: localDate(input.observedAt, prefs.timeZone),
    timing: { kind: 'immediate' },
    subjectId: ids.join('+'),
    variant: null,
    subscriptionId: first.subscriptionId,
  });
  if (plan === null) return [];

  const payload: DuplicateDetectedPayload = { subscriptions: input.subscriptions };
  return [{ ...plan, type: 'duplicate_detected', payload }];
}

// ── shared helpers for the digest ──────────────────────────────────────────────────────

export type { NotificationRequestBase };
export { planRequest as planNotificationRequest };

/** How many whole local days from `from` to `to`. Exposed for copy like "in 3 days". */
export function daysUntil(from: PlainDate, to: PlainDate): number {
  return daysBetween(from, to);
}
