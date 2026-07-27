/**
 * The shapes that cross this package's boundaries.
 *
 * A `NotificationRequest` is a decision, not a delivery: pure scheduling code produces it, a
 * worker persists it against the UNIQUE `dedupe_key`, and only then does a `Channel` touch the
 * network. Keeping the decision separate from the send is what lets the whole of `schedule.ts`
 * be tested on a frozen clock with no database and no mocks.
 *
 * Payloads are frozen at schedule time and stored as JSONB, so everything in them is
 * JSON-representable: `Money` is already a plain `{ amountMinor, currency }` object and dates
 * cross as `YYYY-MM-DD` strings. A template must never need to re-derive a number the scheduler
 * already computed — if the email says "£36.00 a year more", that figure was computed once, by
 * the code that decided to send it, and is not recalculated in a React component.
 */

import type {
  Money,
  NotificationChannel,
  NotificationType,
  RecurrenceInterval,
} from '@ledger/core';

/** A calendar date as `YYYY-MM-DD`. */
export type IsoDate = string;

/** Enough of a subscription for any template to state the fact and the number. */
export interface SubscriptionRef {
  readonly subscriptionId: string;
  readonly name: string;
  readonly amount: Money;
  readonly interval: RecurrenceInterval;
}

// ── per-type payloads ──────────────────────────────────────────────────────────────────

export interface TrialEndingPayload {
  readonly subscription: SubscriptionRef;
  /** The day the trial converts, in the user's timezone. */
  readonly trialEndsOn: IsoDate;
  readonly leadTimeDays: number;
}

export interface RenewalUpcomingPayload {
  readonly subscription: SubscriptionRef;
  readonly renewsOn: IsoDate;
  readonly leadTimeDays: number;
}

/**
 * A price change, stated the way a person actually feels it.
 *
 * "£9.99 → £12.99" is a shrug. "£36.00 a year more" is a decision. Both the per-charge figures
 * and the annualized ones are carried so the email can lead with the annual delta and still show
 * its working.
 */
export interface PriceChangedPayload {
  readonly subscription: SubscriptionRef;
  readonly previousAmount: Money;
  readonly newAmount: Money;
  readonly previousAnnual: Money;
  readonly newAnnual: Money;
  /** newAnnual − previousAnnual. Negative when the price went down. */
  readonly annualDelta: Money;
  /** Relative change in basis points; null when the previous amount was zero. */
  readonly deltaBps: number | null;
  readonly effectiveFrom: IsoDate;
}

export interface CancelByDeadlinePayload {
  readonly subscription: SubscriptionRef;
  readonly cancellationRequestId: string | null;
  readonly deadlineOn: IsoDate;
  /** How many days before the deadline this particular alert speaks. 7 or 1. */
  readonly leadTimeDays: number;
}

export interface CancellationUnconfirmedPayload {
  readonly subscription: SubscriptionRef;
  readonly cancellationRequestId: string;
  readonly deadlineOn: IsoDate;
  readonly daysSinceDeadline: number;
}

/**
 * The most important payload in the product.
 *
 * A charge landed after the user cancelled. The email has to answer, without the user opening
 * anything: who charged, how much, when, when did I cancel, and where is the proof.
 */
export interface ChargedAfterCancellationPayload {
  readonly subscription: SubscriptionRef;
  readonly cancellationRequestId: string | null;
  readonly transactionId: string;
  readonly merchantName: string;
  readonly amount: Money;
  readonly chargedOn: IsoDate;
  readonly cancelledOn: IsoDate;
  /** The provider's own confirmation code, if the user recorded one. */
  readonly confirmationReference: string | null;
  /** How many files are attached to the cancellation record. */
  readonly evidenceCount: number;
}

export interface DetectionSummary {
  readonly detectionId: string;
  readonly name: string;
  readonly amount: Money;
  readonly interval: RecurrenceInterval;
}

export interface NewDetectionsPayload {
  /** The local date of the digest itself — also the event date its dedupe key is built from. */
  readonly weekOf: IsoDate;
  readonly items: readonly DetectionSummary[];
}

export interface SyncFailedPayload {
  readonly connectionId: string;
  readonly institutionName: string;
  /** The first day of this failing run, not the day we noticed. See `scheduleSyncFailed`. */
  readonly failingSince: IsoDate;
}

export interface ConsentExpiringPayload {
  readonly connectionId: string;
  readonly institutionName: string;
  readonly expiresOn: IsoDate;
  readonly leadTimeDays: number;
}

export interface DuplicateDetectedPayload {
  /** Two or more subscriptions that look like the same service. */
  readonly subscriptions: readonly SubscriptionRef[];
}

/** The payload each notification type carries. Exhaustive over `NotificationType` by construction. */
export interface NotificationPayloads {
  readonly trial_ending: TrialEndingPayload;
  readonly renewal_upcoming: RenewalUpcomingPayload;
  readonly price_changed: PriceChangedPayload;
  readonly cancel_by_deadline: CancelByDeadlinePayload;
  readonly cancellation_unconfirmed: CancellationUnconfirmedPayload;
  readonly charged_after_cancellation: ChargedAfterCancellationPayload;
  readonly new_detections: NewDetectionsPayload;
  readonly sync_failed: SyncFailedPayload;
  readonly consent_expiring: ConsentExpiringPayload;
  readonly duplicate_detected: DuplicateDetectedPayload;
}

export type NotificationPayloadFor<T extends NotificationType> = NotificationPayloads[T];

// ── the request ────────────────────────────────────────────────────────────────────────

/**
 * `high` exists to answer one question at send time: may this jump the quiet-hours boundary and
 * the sender queue? Only `charged_after_cancellation` is high, and it is high because dispute
 * windows are short.
 */
export type NotificationPriority = 'normal' | 'high';

export interface NotificationRequestBase {
  readonly userId: string;
  /**
   * Stable across scheduler restarts and clock drift, because it is derived from the *subject*
   * and the *event date* — never from the moment the scheduler happened to run. This is the
   * value that hits the UNIQUE index on `notifications.dedupe_key`, and it is the entire
   * mechanism behind "a user must never be told the same thing twice".
   */
  readonly dedupeKey: string;
  /** When to deliver, after quiet hours have been applied. */
  readonly scheduledFor: Date;
  /** The pre-quiet-hours instant, when it differed. Kept so the UI can explain the delay. */
  readonly deferredFrom: Date | null;
  readonly channels: readonly NotificationChannel[];
  readonly priority: NotificationPriority;
  /** Set when the notification is about one subscription, for the inbox deep link. */
  readonly subscriptionId: string | null;
}

type RequestOf<T extends NotificationType> = NotificationRequestBase & {
  readonly type: T;
  readonly payload: NotificationPayloads[T];
};

/**
 * Discriminated on `type`, so the renderer's switch is exhaustive and adding a notification type
 * without a template is a compile error rather than a blank email.
 */
export type NotificationRequest = { [T in NotificationType]: RequestOf<T> }[NotificationType];

// ── rendering ──────────────────────────────────────────────────────────────────────────

export interface RenderedNotification {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** The one screen this notification is about. Every template links straight to it. */
  readonly url: string;
}

/** Everything rendering needs that is about the reader rather than the event. */
export interface RenderContext {
  readonly appUrl: string;
  readonly locale: string;
  readonly timeZone: string;
}

// ── channels ───────────────────────────────────────────────────────────────────────────

/**
 * The outcome of one delivery attempt.
 *
 * `skipped` is deliberately not `failed`: a user with no push subscriptions, or an email channel
 * running without an API key, is a configuration fact rather than an error, and burning retry
 * attempts on it is how a sender queue fills with work that can never succeed.
 */
export type DeliveryResult =
  | { readonly status: 'sent'; readonly detail?: string | undefined }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string; readonly retryable: boolean };

export interface Channel {
  readonly name: NotificationChannel;
  send(request: NotificationRequest, rendered: RenderedNotification): Promise<DeliveryResult>;
}
