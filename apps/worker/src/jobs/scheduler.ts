/**
 * The scheduler — the repeatable job that materialises `notifications` rows.
 *
 * It re-derives every due notification from scratch on every run and relies on the insert
 * conflicting to drop the ones that already exist. That is not a performance compromise, it is
 * the correctness argument: `notifications.dedupe_key` is UNIQUE, every key produced by
 * `@ledger/notify` is a function of the *subject* and the *event date* and never of `now`, and
 * therefore two workers running this job at the same instant, or one worker running it twice
 * after a restart, produce byte-identical keys and exactly one row survives.
 *
 * That property is the entire "a user is never told the same thing twice" guarantee (brief §8),
 * and it is why nothing in this file reads a row to decide whether to write one. A
 * read-then-write would reintroduce the race the constraint exists to remove.
 *
 * The decision half is `planUserNotifications`, which takes rows and a `Clock` and returns
 * requests. It touches no database and no system clock, so every rule below — "the trial alert
 * fires three days early", "a renewal below the user's threshold is not worth an email" — is
 * testable without Postgres.
 *
 * Two notification types are deliberately absent. `cancellation_unconfirmed` belongs to the
 * follow-up job, which owns `last_nudged_at`; `charged_after_cancellation` belongs to the
 * verification job, which is the only thing that knows a charge landed.
 */

import { and, eq, gte, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import {
  type Clock,
  type IntervalUnit,
  type SubscriptionStatus,
  interval,
  isCommitted,
  money,
} from '@ledger/core';
import {
  type Database,
  bankConnections,
  cancellationRequests,
  detections,
  merchants,
  subscriptions,
  users,
} from '@ledger/db';
import {
  type DetectionSummary,
  type NotificationRequest,
  type UserNotificationPreferences,
  scheduleCancelByDeadline,
  scheduleConsentExpiring,
  scheduleRenewalUpcoming,
  scheduleTrialEnding,
  scheduleWeeklyDigest,
} from '@ledger/notify';

import type { WorkerContext } from '../context';
import { loadPreferences } from '../preferences';
import { persistNotifications } from '../notifications';

/**
 * How far ahead the scheduler materialises.
 *
 * Longer than the longest lead time (14 days, for consent expiry) with room for a worker that was
 * down for a day. Deliberately not "everything": a renewal eighteen months out would otherwise
 * get a row now, scheduled for then, frozen against a price and a name that will have changed.
 */
export const SCHEDULING_HORIZON_DAYS = 35;

/** How far back "new detections" reaches for the weekly digest. */
export const DIGEST_LOOKBACK_DAYS = 7;

const MILLIS_PER_DAY = 86_400_000;

export interface SchedulerSubscription {
  readonly id: string;
  readonly displayName: string;
  readonly status: SubscriptionStatus;
  readonly amountMinor: number;
  readonly currency: string;
  readonly intervalUnit: IntervalUnit;
  readonly intervalCount: number;
  readonly trialEndsAt: Date | null;
  readonly nextRenewalAt: Date | null;
  readonly cancelByAt: Date | null;
  /** The open cancellation for this subscription, so the deadline email deep-links to it. */
  readonly cancellationRequestId: string | null;
}

export interface SchedulerConnection {
  readonly id: string;
  readonly institutionName: string;
  readonly consentExpiresAt: Date | null;
}

export interface SchedulerUserInput {
  readonly prefs: UserNotificationPreferences;
  readonly subscriptions: readonly SchedulerSubscription[];
  readonly connections: readonly SchedulerConnection[];
  readonly newDetections: readonly DetectionSummary[];
}

/** True when an event is close enough to be worth a row today. */
export function withinHorizon(at: Date, clock: Clock, days: number = SCHEDULING_HORIZON_DAYS): boolean {
  return at.getTime() <= clock.epochMillis() + days * MILLIS_PER_DAY;
}

function refFor(subscription: SchedulerSubscription): {
  subscriptionId: string;
  name: string;
  amount: ReturnType<typeof money>;
  interval: ReturnType<typeof interval>;
} {
  return {
    subscriptionId: subscription.id,
    name: subscription.displayName,
    amount: money(subscription.amountMinor, subscription.currency),
    interval: interval(subscription.intervalUnit, subscription.intervalCount),
  };
}

/**
 * Everything one user should be told about, right now.
 *
 * Order is not significant — the insert is a single statement and the dedupe key decides what
 * survives — but keeping the per-type blocks separate means a rule can be read, and changed,
 * without reading the others.
 */
export function planUserNotifications(
  input: SchedulerUserInput,
  clock: Clock,
): NotificationRequest[] {
  const out: NotificationRequest[] = [];

  for (const subscription of input.subscriptions) {
    const ref = refFor(subscription);

    if (subscription.status === 'trialing' && subscription.trialEndsAt !== null) {
      if (withinHorizon(subscription.trialEndsAt, clock)) {
        out.push(
          ...scheduleTrialEnding(
            { subscription: ref, trialEndsAt: subscription.trialEndsAt },
            input.prefs,
            clock,
          ),
        );
      }
    }

    // A paused or lapsed subscription is not going to renew, and telling someone a renewal is
    // coming when the charges have stopped is worse than saying nothing.
    if (isCommitted(subscription.status) && subscription.nextRenewalAt !== null) {
      if (withinHorizon(subscription.nextRenewalAt, clock)) {
        out.push(
          ...scheduleRenewalUpcoming(
            // There is no per-subscription opt-in column, so the amount decides against the
            // user's threshold — which is what `alertOptIn: null` means to the scheduler.
            { subscription: ref, renewsAt: subscription.nextRenewalAt, alertOptIn: null },
            input.prefs,
            clock,
          ),
        );
      }
    }

    if (subscription.cancelByAt !== null && withinHorizon(subscription.cancelByAt, clock)) {
      out.push(
        ...scheduleCancelByDeadline(
          {
            subscription: ref,
            cancellationRequestId: subscription.cancellationRequestId,
            deadlineAt: subscription.cancelByAt,
          },
          input.prefs,
          clock,
        ),
      );
    }
  }

  for (const connection of input.connections) {
    if (connection.consentExpiresAt === null) continue;
    if (!withinHorizon(connection.consentExpiresAt, clock)) continue;
    out.push(
      ...scheduleConsentExpiring(
        {
          connectionId: connection.id,
          institutionName: connection.institutionName,
          expiresAt: connection.consentExpiresAt,
        },
        input.prefs,
        clock,
      ),
    );
  }

  // Returns null when there is nothing to say, and an empty digest is worse than no digest.
  const digest = scheduleWeeklyDigest({ detections: input.newDetections }, input.prefs, clock);
  if (digest !== null) out.push(digest);

  return out;
}

// ── IO ─────────────────────────────────────────────────────────────────────────────────

export interface SchedulerSummary {
  readonly users: number;
  readonly planned: number;
  readonly inserted: number;
  readonly duplicates: number;
}

/** How many users one pass loads at a time. Bounds the memory of a large instance. */
export const USER_BATCH_SIZE = 200;

export async function runScheduler(ctx: WorkerContext): Promise<SchedulerSummary> {
  const log = ctx.log.child({ job: 'scheduler' });
  const horizon = new Date(ctx.clock.epochMillis() + SCHEDULING_HORIZON_DAYS * MILLIS_PER_DAY);
  const digestSince = new Date(ctx.clock.epochMillis() - DIGEST_LOOKBACK_DAYS * MILLIS_PER_DAY);

  let offset = 0;
  let seen = 0;
  let planned = 0;
  let inserted = 0;
  let duplicates = 0;

  for (;;) {
    const batch = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(isNull(users.deletedAt))
      .orderBy(users.id)
      .limit(USER_BATCH_SIZE)
      .offset(offset);

    if (batch.length === 0) break;
    offset += batch.length;
    seen += batch.length;

    const ids = batch.map((row) => row.id);
    const [prefs, subs, connections, newDetections] = await Promise.all([
      loadPreferences(ctx.db, ids),
      loadSubscriptions(ctx.db, ids, horizon),
      loadConnections(ctx.db, ids, horizon),
      loadNewDetections(ctx.db, ids, digestSince),
    ]);

    const requests: NotificationRequest[] = [];
    for (const id of ids) {
      const userPrefs = prefs.get(id);
      if (userPrefs === undefined) continue;
      requests.push(
        ...planUserNotifications(
          {
            prefs: userPrefs,
            subscriptions: subs.get(id) ?? [],
            connections: connections.get(id) ?? [],
            newDetections: newDetections.get(id) ?? [],
          },
          ctx.clock,
        ),
      );
    }

    planned += requests.length;
    const result = await persistNotifications(ctx.db, requests);
    inserted += result.inserted;
    duplicates += result.duplicates;

    if (batch.length < USER_BATCH_SIZE) break;
  }

  const summary: SchedulerSummary = { users: seen, planned, inserted, duplicates };
  log.info(summary, 'scheduler pass complete');
  return summary;
}

async function loadSubscriptions(
  db: Database,
  userIds: readonly string[],
  horizon: Date,
): Promise<Map<string, SchedulerSubscription[]>> {
  const rows = await db
    .select({
      userId: subscriptions.userId,
      id: subscriptions.id,
      displayName: subscriptions.displayName,
      status: subscriptions.status,
      amountMinor: subscriptions.amountMinor,
      currency: subscriptions.currency,
      intervalUnit: subscriptions.intervalUnit,
      intervalCount: subscriptions.intervalCount,
      trialEndsAt: subscriptions.trialEndsAt,
      nextRenewalAt: subscriptions.nextRenewalAt,
      cancelByAt: subscriptions.cancelByAt,
      cancellationRequestId: cancellationRequests.id,
    })
    .from(subscriptions)
    .leftJoin(
      cancellationRequests,
      and(
        eq(cancellationRequests.subscriptionId, subscriptions.id),
        inArray(cancellationRequests.status, ['draft', 'in_progress', 'awaiting_confirmation']),
      ),
    )
    .where(
      and(
        inArray(subscriptions.userId, [...userIds]),
        isNull(subscriptions.archivedAt),
        // Anything with no dated event inside the horizon cannot produce a notification, so it
        // is filtered in SQL rather than loaded and discarded per user.
        or(
          and(isNotNull(subscriptions.trialEndsAt), lte(subscriptions.trialEndsAt, horizon)),
          and(isNotNull(subscriptions.nextRenewalAt), lte(subscriptions.nextRenewalAt, horizon)),
          and(isNotNull(subscriptions.cancelByAt), lte(subscriptions.cancelByAt, horizon)),
        ),
      ),
    );

  return groupBy(rows, (row) => row.userId);
}

async function loadConnections(
  db: Database,
  userIds: readonly string[],
  horizon: Date,
): Promise<Map<string, SchedulerConnection[]>> {
  const rows = await db
    .select({
      userId: bankConnections.userId,
      id: bankConnections.id,
      institutionName: bankConnections.institutionName,
      consentExpiresAt: bankConnections.consentExpiresAt,
    })
    .from(bankConnections)
    .where(
      and(
        inArray(bankConnections.userId, [...userIds]),
        isNotNull(bankConnections.consentExpiresAt),
        lte(bankConnections.consentExpiresAt, horizon),
      ),
    );

  return groupBy(rows, (row) => row.userId);
}

/**
 * Detections raised since the last digest.
 *
 * `pending` only: a detection the user already confirmed or dismissed is an answered question,
 * and putting it in a digest asks it again.
 */
async function loadNewDetections(
  db: Database,
  userIds: readonly string[],
  since: Date,
): Promise<Map<string, DetectionSummary[]>> {
  const rows = await db
    .select({
      userId: detections.userId,
      id: detections.id,
      normalizedKey: detections.normalizedKey,
      merchantName: merchants.name,
      medianAmountMinor: detections.medianAmountMinor,
      currency: detections.currency,
      intervalUnit: detections.intervalUnit,
      intervalCount: detections.intervalCount,
    })
    .from(detections)
    .leftJoin(merchants, eq(detections.merchantId, merchants.id))
    .where(
      and(
        inArray(detections.userId, [...userIds]),
        eq(detections.status, 'pending'),
        gte(detections.createdAt, since),
      ),
    );

  const out = new Map<string, DetectionSummary[]>();
  for (const row of rows) {
    const list = out.get(row.userId) ?? [];
    list.push({
      detectionId: row.id,
      // The registry name when we have one; the normalised descriptor is a poor label but an
      // honest one, and inventing a prettier string would misrepresent what was matched.
      name: row.merchantName ?? row.normalizedKey,
      amount: money(row.medianAmountMinor, row.currency),
      interval: interval(row.intervalUnit, row.intervalCount),
    });
    out.set(row.userId, list);
  }
  return out;
}

function groupBy<T extends { readonly userId: string }>(
  rows: readonly T[],
  key: (row: T) => string,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const list = out.get(id) ?? [];
    list.push(row);
    out.set(id, list);
  }
  return out;
}
