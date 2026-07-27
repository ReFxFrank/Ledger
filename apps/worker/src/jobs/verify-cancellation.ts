/**
 * Verification — brief §3.1 step 7, and the reason this product is worth building.
 *
 * Every subscription tracker can tell you what you pay. What almost none of them do is check,
 * afterwards, whether the charge actually stopped. A cancellation is a *claim* until a billing
 * period passes without a payment; this job is what turns the claim into a fact, and it is the
 * difference between `confirmed` and `verified` in the cancellation state machine.
 *
 * The shape of the check:
 *
 *   window = [ expectedNextChargeAt − 3 days , verificationWindowEndsAt ]
 *
 * Three days of lead because merchants bill early as often as late, and a tail because charges
 * post late — a 12-day tail is not an anomaly, it is a bank holiday weekend.
 *
 *   ABSENT  → the cancellation is verified. The user is told it is confirmed *because the charge
 *             did not come*, which is a materially different sentence from "the provider said so".
 *   PRESENT → the loud case. The request fails, the subscription goes back to `active` because it
 *             demonstrably is, and `charged_after_cancellation` fires immediately, ignoring quiet
 *             hours, carrying the merchant, the amount, both dates, and the evidence count.
 *
 * Absence is only concluded once the window has closed — you cannot prove a charge did not happen
 * while it could still arrive. Presence is concluded the moment it is seen, because card-scheme
 * dispute windows start running from the charge and not from when the user noticed.
 *
 * All of that is `planVerification`, a pure function over rows and a `Clock`. The runner below it
 * does nothing but load rows, apply the plan, and write the timeline.
 *
 * One honest gap: the `notification_type` enum is frozen and has no member for "your
 * cancellation was verified", so the verified outcome is recorded as a `verified` row on
 * `cancellation_events` — which is what the cancellation screen renders as its timeline — rather
 * than emailed. `VerifiedAnnouncement` carries everything such a notification would need, so
 * adding the type is a migration plus one call, not a rewrite.
 */

import { and, eq, gte, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import {
  type CancellationStatus,
  type Clock,
  type IntervalUnit,
  type Money,
  type SubscriptionStatus,
  interval,
  money,
} from '@ledger/core';
import {
  type CancellationTrigger,
  type Database,
  type TransitionTrigger,
  Scope,
  attachments,
  canTransitionCancellation,
  cancellationEvents,
  cancellationRequests,
  detections,
  resolveTransition,
  subscriptions,
  transactions,
  transitionCancellation,
} from '@ledger/db';
import {
  type ChargedAfterCancellationInput,
  type SubscriptionRef,
  scheduleChargedAfterCancellation,
} from '@ledger/notify';

import type { WorkerContext } from '../context';
import { loadPreferences } from '../preferences';
import { persistNotifications } from '../notifications';

// ── the window ─────────────────────────────────────────────────────────────────────────

/** Merchants bill early as often as late. Three days of lead, not zero. */
export const CHARGE_LOOKBACK_DAYS = 3;

/**
 * How far an amount may drift and still be "the charge we were watching for".
 *
 * 15% covers a price rise, a tax change, and a partial-period proration. Wider than that and a
 * genuinely different charge from the same merchant — a one-off purchase — starts matching, and a
 * false `charged_after_cancellation` is the single most damaging thing this job could send.
 */
export const AMOUNT_TOLERANCE_BPS = 1_500;

/** A floor, so a £1.99 subscription is not held to a 30p window. Integer minor units throughout. */
export const MIN_AMOUNT_TOLERANCE_MINOR = 100;

const MILLIS_PER_DAY = 86_400_000;

// ── the rows this job reasons about ────────────────────────────────────────────────────

export interface VerificationSubscription {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly displayName: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly intervalUnit: IntervalUnit;
  readonly intervalCount: number;
  readonly merchantId: string | null;
  /** Clustering keys the charges from this merchant carry, from the detection that produced it. */
  readonly normalizedKeys: readonly string[];
}

export interface VerificationRequest {
  readonly id: string;
  readonly userId: string;
  readonly subscriptionId: string;
  readonly status: CancellationStatus;
  readonly expectedNextChargeAt: Date | null;
  readonly verificationWindowEndsAt: Date | null;
  readonly confirmationReference: string | null;
  /** When the user cancelled: the provider's effective date if there is one, else when they started. */
  readonly cancelledAt: Date;
  /** How many files are attached to this record. The proof, if it comes to a dispute. */
  readonly evidenceCount: number;
}

export interface CandidateCharge {
  readonly id: string;
  readonly postedAt: Date;
  /** Positive = money leaving the account, normalised at the adapter boundary. */
  readonly amountMinor: number;
  readonly currency: string;
  readonly normalizedKey: string;
  readonly merchantId: string | null;
  readonly subscriptionId: string | null;
  readonly rawDescriptor: string;
  readonly pending: boolean;
}

export interface VerificationCase {
  readonly request: VerificationRequest;
  readonly subscription: VerificationSubscription;
  /** Everything posted in the window that could plausibly be this merchant. */
  readonly charges: readonly CandidateCharge[];
}

export interface ChargeWindow {
  readonly from: Date;
  readonly to: Date;
}

// ── pure: the window, the match, the decision ──────────────────────────────────────────

export function chargeWindowFor(request: VerificationRequest): ChargeWindow | null {
  const { expectedNextChargeAt, verificationWindowEndsAt } = request;
  if (expectedNextChargeAt === null || verificationWindowEndsAt === null) return null;
  return {
    from: new Date(expectedNextChargeAt.getTime() - CHARGE_LOOKBACK_DAYS * MILLIS_PER_DAY),
    to: verificationWindowEndsAt,
  };
}

/**
 * Integer-only amount comparison.
 *
 * `Math.abs(a − b) * 10_000 ≤ expected * bps` rather than a ratio, because a ratio is a float and
 * money never touches one (brief §11). Both sides stay well inside the safe integer range for any
 * amount a subscription could plausibly be.
 */
export function amountMatches(expectedMinor: number, actualMinor: number): boolean {
  const expected = Math.abs(expectedMinor);
  const tolerance = Math.max(
    MIN_AMOUNT_TOLERANCE_MINOR,
    Math.floor((expected * AMOUNT_TOLERANCE_BPS) / 10_000),
  );
  return Math.abs(actualMinor - expectedMinor) <= tolerance;
}

export function chargeMatchesSubscription(
  charge: CandidateCharge,
  subscription: VerificationSubscription,
): boolean {
  // A refund is money coming back, and a refund from the merchant we just cancelled is evidence
  // the cancellation worked rather than evidence it did not.
  if (charge.amountMinor <= 0) return false;
  // Comparing across currencies would mean guessing at an FX rate to decide whether a user was
  // charged again. Not worth being wrong about.
  if (charge.currency !== subscription.currency) return false;
  if (!amountMatches(subscription.amountMinor, charge.amountMinor)) return false;

  if (charge.subscriptionId === subscription.id) return true;
  if (
    charge.merchantId !== null &&
    subscription.merchantId !== null &&
    charge.merchantId === subscription.merchantId
  ) {
    return true;
  }
  return subscription.normalizedKeys.includes(charge.normalizedKey);
}

/**
 * The charge that says the cancellation did not take, or null.
 *
 * Posted rows win over pending ones: a pending authorisation can still be dropped, and when both
 * a pending row and its posted re-issue are in the window they are the same charge seen twice.
 * A pending row on its own still counts — waiting for it to settle would spend three days of a
 * dispute window on a formality.
 */
export function findChargeAfterCancellation(kase: VerificationCase): CandidateCharge | null {
  const window = chargeWindowFor(kase.request);
  if (window === null) return null;

  const matches = kase.charges.filter(
    (charge) =>
      charge.postedAt.getTime() >= window.from.getTime() &&
      charge.postedAt.getTime() <= window.to.getTime() &&
      chargeMatchesSubscription(charge, kase.subscription),
  );
  if (matches.length === 0) return null;

  const ordered = [...matches].sort((a, b) => {
    if (a.pending !== b.pending) return a.pending ? 1 : -1;
    return a.postedAt.getTime() - b.postedAt.getTime();
  });
  return ordered[0] ?? null;
}

/** Everything a "your cancellation is verified" message would need, if the enum had a member. */
export interface VerifiedAnnouncement {
  readonly userId: string;
  readonly subscriptionId: string;
  readonly subscriptionName: string;
  readonly amount: Money;
  readonly expectedChargeOn: Date;
  readonly windowClosedOn: Date;
  /** The sentence that makes this different from "the provider said so". */
  readonly because: 'expected_charge_did_not_arrive';
}

export type WaitReason =
  | 'no_verification_window'
  | 'not_due_yet'
  | 'window_still_open'
  | 'status_cannot_be_verified'
  | 'status_not_watchable';

export interface WaitDecision {
  readonly kind: 'wait';
  readonly requestId: string;
  readonly reason: WaitReason;
}

/**
 * A validated status change, with the status it was validated *from*.
 *
 * `from` is carried rather than re-derived because the write is guarded on it: the update only
 * lands if the row is still in the state the plan was made against, which is how a user editing
 * the same record a second earlier wins instead of being silently overwritten.
 */
export interface PlannedCancellationMove {
  readonly from: CancellationStatus;
  readonly to: CancellationStatus;
  readonly trigger: CancellationTrigger;
  readonly describe: string;
}

export interface PlannedSubscriptionMove {
  readonly from: SubscriptionStatus;
  readonly to: SubscriptionStatus;
  readonly trigger: TransitionTrigger;
  readonly describe: string;
}

export interface VerifiedDecision {
  readonly kind: 'verified';
  readonly requestId: string;
  readonly userId: string;
  readonly subscriptionId: string;
  readonly at: Date;
  readonly request: PlannedCancellationMove;
  /** Null when the subscription has already moved somewhere the machine will not leave. */
  readonly subscription: PlannedSubscriptionMove | null;
  readonly window: ChargeWindow;
  readonly announcement: VerifiedAnnouncement;
}

export interface ChargedDecision {
  readonly kind: 'charged';
  readonly requestId: string;
  readonly userId: string;
  readonly subscriptionId: string;
  readonly at: Date;
  readonly charge: CandidateCharge;
  readonly request: PlannedCancellationMove;
  readonly subscription: PlannedSubscriptionMove | null;
  readonly window: ChargeWindow;
  /** Handed straight to `scheduleChargedAfterCancellation`. */
  readonly notification: ChargedAfterCancellationInput;
}

export type VerificationDecision = WaitDecision | VerifiedDecision | ChargedDecision;

function subscriptionRef(subscription: VerificationSubscription): SubscriptionRef {
  return {
    subscriptionId: subscription.id,
    name: subscription.displayName,
    amount: money(subscription.amountMinor, subscription.currency),
    interval: interval(subscription.intervalUnit, subscription.intervalCount),
  };
}

/**
 * One request, one decision.
 *
 * Every status change is resolved through the two state machines rather than assigned. That is
 * not ceremony: this job and the user race. A user who reactivated a subscription an hour ago
 * must not have that silently overwritten by a verification run concluding "no charge appeared",
 * and `resolveTransition` returning null is exactly how this job notices and leaves the
 * subscription alone while still recording the cancellation outcome.
 */
export function planVerification(kase: VerificationCase, clock: Clock): VerificationDecision {
  const { request, subscription } = kase;
  const now = clock.now();

  const window = chargeWindowFor(request);
  if (window === null) {
    return { kind: 'wait', requestId: request.id, reason: 'no_verification_window' };
  }
  const expected = request.expectedNextChargeAt;
  if (expected === null || now.getTime() < expected.getTime()) {
    return { kind: 'wait', requestId: request.id, reason: 'not_due_yet' };
  }

  const charge = findChargeAfterCancellation(kase);

  if (charge !== null) {
    if (!canTransitionCancellation(request.status, 'verification_failed', 'failed')) {
      return { kind: 'wait', requestId: request.id, reason: 'status_not_watchable' };
    }
    const move = transitionCancellation(request.status, 'verification_failed', 'failed');
    const onSubscription = resolveTransition(subscription.status, 'charge_after_cancellation');

    const notification: ChargedAfterCancellationInput = {
      subscription: subscriptionRef(subscription),
      cancellationRequestId: request.id,
      transactionId: charge.id,
      merchantName: subscription.displayName,
      amount: money(charge.amountMinor, charge.currency),
      chargedAt: charge.postedAt,
      cancelledAt: request.cancelledAt,
      confirmationReference: request.confirmationReference,
      evidenceCount: request.evidenceCount,
    };

    return {
      kind: 'charged',
      requestId: request.id,
      userId: request.userId,
      subscriptionId: subscription.id,
      at: now,
      charge,
      request: {
        from: move.from,
        to: move.to,
        trigger: 'verification_failed',
        describe: move.describe,
      },
      subscription:
        onSubscription === null
          ? null
          : {
              from: onSubscription.from,
              to: onSubscription.to,
              trigger: 'charge_after_cancellation',
              describe: onSubscription.describe,
            },
      window,
      notification,
    };
  }

  // No charge. Absence only means anything once nothing more can arrive.
  if (now.getTime() < window.to.getTime()) {
    return { kind: 'wait', requestId: request.id, reason: 'window_still_open' };
  }
  if (!canTransitionCancellation(request.status, 'verification_passed', 'verified')) {
    // `awaiting_confirmation` lands here by design. No charge arrived, but the provider never
    // confirmed anything either, so there is no claim to verify — that request belongs to the
    // follow-up job, which chases the user for a confirmation.
    return { kind: 'wait', requestId: request.id, reason: 'status_cannot_be_verified' };
  }

  const move = transitionCancellation(request.status, 'verification_passed', 'verified');
  const onSubscription = resolveTransition(subscription.status, 'cancellation_verified');

  return {
    kind: 'verified',
    requestId: request.id,
    userId: request.userId,
    subscriptionId: subscription.id,
    at: now,
    request: {
      from: move.from,
      to: move.to,
      trigger: 'verification_passed',
      describe: move.describe,
    },
    subscription:
      onSubscription === null
        ? null
        : {
            from: onSubscription.from,
            to: onSubscription.to,
            trigger: 'cancellation_verified',
            describe: onSubscription.describe,
          },
    window,
    announcement: {
      userId: request.userId,
      subscriptionId: subscription.id,
      subscriptionName: subscription.displayName,
      amount: money(subscription.amountMinor, subscription.currency),
      expectedChargeOn: expected,
      windowClosedOn: window.to,
      because: 'expected_charge_did_not_arrive',
    },
  };
}

export function planVerifications(
  cases: readonly VerificationCase[],
  clock: Clock,
): VerificationDecision[] {
  return cases.map((kase) => planVerification(kase, clock));
}

// ── IO ─────────────────────────────────────────────────────────────────────────────────

export interface VerifyRunSummary {
  readonly examined: number;
  readonly verified: number;
  readonly charged: number;
  readonly waiting: number;
  readonly notificationsQueued: number;
}

/** Statuses worth watching against the bank feed. Mirrors `awaitsVerification` in @ledger/db. */
const WATCHED: readonly CancellationStatus[] = ['confirmed', 'awaiting_confirmation'];

export async function runVerifyCancellations(ctx: WorkerContext): Promise<VerifyRunSummary> {
  const log = ctx.log.child({ job: 'verify-cancellation' });
  const now = ctx.clock.now();

  const rows = await ctx.db
    .select({
      requestId: cancellationRequests.id,
      userId: cancellationRequests.userId,
      status: cancellationRequests.status,
      expectedNextChargeAt: cancellationRequests.expectedNextChargeAt,
      verificationWindowEndsAt: cancellationRequests.verificationWindowEndsAt,
      confirmationReference: cancellationRequests.confirmationReference,
      effectiveAt: cancellationRequests.effectiveAt,
      startedAt: cancellationRequests.startedAt,
      subscriptionId: subscriptions.id,
      subscriptionStatus: subscriptions.status,
      displayName: subscriptions.displayName,
      amountMinor: subscriptions.amountMinor,
      currency: subscriptions.currency,
      intervalUnit: subscriptions.intervalUnit,
      intervalCount: subscriptions.intervalCount,
      merchantId: subscriptions.merchantId,
    })
    .from(cancellationRequests)
    .innerJoin(subscriptions, eq(cancellationRequests.subscriptionId, subscriptions.id))
    .where(
      and(
        inArray(cancellationRequests.status, [...WATCHED]),
        isNotNull(cancellationRequests.expectedNextChargeAt),
        lte(cancellationRequests.expectedNextChargeAt, now),
      ),
    );

  if (rows.length === 0) {
    return { examined: 0, verified: 0, charged: 0, waiting: 0, notificationsQueued: 0 };
  }

  const summary = { verified: 0, charged: 0, waiting: 0, notificationsQueued: 0 };

  for (const row of rows) {
    const scope = new Scope(ctx.db, row.userId);

    const request: VerificationRequest = {
      id: row.requestId,
      userId: row.userId,
      subscriptionId: row.subscriptionId,
      status: row.status,
      expectedNextChargeAt: row.expectedNextChargeAt,
      verificationWindowEndsAt: row.verificationWindowEndsAt,
      confirmationReference: row.confirmationReference,
      cancelledAt: row.effectiveAt ?? row.startedAt,
      evidenceCount: await countEvidence(ctx.db, scope, row.requestId),
    };

    const subscription: VerificationSubscription = {
      id: row.subscriptionId,
      status: row.subscriptionStatus,
      displayName: row.displayName,
      amountMinor: row.amountMinor,
      currency: row.currency,
      intervalUnit: row.intervalUnit,
      intervalCount: row.intervalCount,
      merchantId: row.merchantId,
      normalizedKeys: await normalizedKeysFor(ctx.db, scope, row.subscriptionId),
    };

    const window = chargeWindowFor(request);
    const charges =
      window === null ? [] : await loadCharges(ctx.db, scope, subscription, window);

    const decision = planVerification({ request, subscription, charges }, ctx.clock);

    if (decision.kind === 'wait') {
      summary.waiting += 1;
      continue;
    }

    await applyDecision(ctx, decision);

    if (decision.kind === 'verified') {
      summary.verified += 1;
      log.info(
        { requestId: decision.requestId, subscriptionId: decision.subscriptionId },
        'cancellation verified — the expected charge never arrived',
      );
    } else {
      summary.charged += 1;
      summary.notificationsQueued += await announceCharge(ctx, decision);
      log.warn(
        {
          requestId: decision.requestId,
          subscriptionId: decision.subscriptionId,
          transactionId: decision.charge.id,
        },
        'charged after cancellation',
      );
    }
  }

  return { examined: rows.length, ...summary };
}

async function countEvidence(db: Database, scope: Scope, requestId: string): Promise<number> {
  const found = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(attachments)
    .where(scope.where(attachments, eq(attachments.requestId, requestId)));
  return found[0]?.count ?? 0;
}

/**
 * The clustering keys this subscription's charges carry.
 *
 * `subscriptions` has no `normalized_key` column — the link runs the other way, through the
 * detection that produced the subscription. Reading it here rather than storing a copy means a
 * re-normalisation that changes a key does not leave a stale one baked into the subscription.
 */
async function normalizedKeysFor(
  db: Database,
  scope: Scope,
  subscriptionId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ normalizedKey: detections.normalizedKey })
    .from(detections)
    .where(scope.where(detections, eq(detections.subscriptionId, subscriptionId)));
  return rows.map((row) => row.normalizedKey);
}

async function loadCharges(
  db: Database,
  scope: Scope,
  subscription: VerificationSubscription,
  window: ChargeWindow,
): Promise<readonly CandidateCharge[]> {
  const identity = or(
    eq(transactions.subscriptionId, subscription.id),
    subscription.merchantId === null
      ? undefined
      : eq(transactions.merchantId, subscription.merchantId),
    subscription.normalizedKeys.length === 0
      ? undefined
      : inArray(transactions.normalizedKey, [...subscription.normalizedKeys]),
  );

  return db
    .select({
      id: transactions.id,
      postedAt: transactions.postedAt,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      normalizedKey: transactions.normalizedKey,
      merchantId: transactions.merchantId,
      subscriptionId: transactions.subscriptionId,
      rawDescriptor: transactions.rawDescriptor,
      pending: transactions.pending,
    })
    .from(transactions)
    .where(
      scope.transactions(
        gte(transactions.postedAt, window.from),
        lte(transactions.postedAt, window.to),
        identity,
      ),
    );
}

/**
 * Applies one decision.
 *
 * All of it in a single transaction, because the three writes are one fact. A request that moved
 * to `failed` without its `cancellation_events` row is a dispute timeline with a hole in it, and
 * the timeline is the thing the user shows their bank.
 */
async function applyDecision(
  ctx: WorkerContext,
  decision: VerifiedDecision | ChargedDecision,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const scope = new Scope(tx, decision.userId);

    await tx
      .update(cancellationRequests)
      .set(
        decision.kind === 'verified'
          ? {
              status: decision.request.to,
              verifiedAt: decision.at,
              resolvedAt: decision.at,
              updatedAt: decision.at,
            }
          : {
              status: decision.request.to,
              chargedAfterCancellationTxId: decision.charge.id,
              resolvedAt: decision.at,
              updatedAt: decision.at,
            },
      )
      // Re-checks the status the plan was made against: another worker, or the user, may have
      // moved this row between the read and here, and the transition it validated no longer holds.
      .where(
        scope.whereId(
          cancellationRequests,
          decision.requestId,
          eq(cancellationRequests.status, decision.request.from),
        ),
      );

    if (decision.subscription !== null) {
      const move = decision.subscription;
      await tx
        .update(subscriptions)
        .set({ status: move.to, updatedAt: decision.at })
        .where(
          scope.whereId(subscriptions, decision.subscriptionId, eq(subscriptions.status, move.from)),
        );
    }

    await tx.insert(cancellationEvents).values({
      requestId: decision.requestId,
      at: decision.at,
      actor: 'system',
      type: decision.kind === 'verified' ? 'verified' : 'charge_detected',
      payload:
        decision.kind === 'verified'
          ? {
              describe: decision.request.describe,
              because: decision.announcement.because,
              searchedFrom: decision.window.from.toISOString(),
              searchedTo: decision.window.to.toISOString(),
              subscriptionStatus: decision.subscription?.to ?? null,
            }
          : {
              describe: decision.request.describe,
              transactionId: decision.charge.id,
              amountMinor: decision.charge.amountMinor,
              currency: decision.charge.currency,
              postedAt: decision.charge.postedAt.toISOString(),
              rawDescriptor: decision.charge.rawDescriptor,
              pending: decision.charge.pending,
              searchedFrom: decision.window.from.toISOString(),
              searchedTo: decision.window.to.toISOString(),
              subscriptionStatus: decision.subscription?.to ?? null,
            },
    });
  });
}

/**
 * Fires `charged_after_cancellation`.
 *
 * Immediate and quiet-hours-exempt — but neither of those is decided here. `@ledger/core`'s
 * `ignoresQuietHours` owns the exemption and `scheduleChargedAfterCancellation` owns the timing,
 * so this job cannot forget either of them.
 */
async function announceCharge(ctx: WorkerContext, decision: ChargedDecision): Promise<number> {
  const prefs = (await loadPreferences(ctx.db, [decision.userId])).get(decision.userId);
  if (prefs === undefined) return 0;

  const requests = scheduleChargedAfterCancellation(decision.notification, prefs, ctx.clock);
  const result = await persistNotifications(ctx.db, requests);
  return result.inserted;
}
