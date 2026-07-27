/**
 * Chasing a cancellation that never came back.
 *
 * A request sitting in `awaiting_confirmation` past its deadline is the state where the product
 * has done its part and the provider has not. The user has to be told, because the deadline is
 * the thing that costs money — miss it and the next billing period is charged in full.
 *
 * The nag has two independent brakes, and both are needed for different reasons:
 *
 *  - `lastNudgedAt` stops this job chasing twice in a day. That is the *job's* brake, and it
 *    matters because the job runs on a schedule that an operator may change, and because a
 *    backlog drain would otherwise fire every pending nudge at once.
 *  - `notifications.dedupe_key` — keyed on the deadline, not on today — stops the user being
 *    *told* twice, ever, no matter how many times this job runs. That is the product's brake.
 *
 * Neither replaces the other: the first bounds the work, the second bounds the noise.
 */

import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { type Clock, type IntervalUnit, interval, money } from '@ledger/core';
import {
  Scope,
  cancellationEvents,
  cancellationRequests,
  subscriptions,
  transitionCancellation,
} from '@ledger/db';
import type { CancellationStatus } from '@ledger/core';
import {
  type CancellationUnconfirmedInput,
  scheduleCancellationUnconfirmed,
} from '@ledger/notify';

import type { WorkerContext } from '../context';
import { loadPreferences } from '../preferences';
import { persistNotifications } from '../notifications';

/** One nudge per day, at most. Anything tighter is nagging rather than helping. */
export const NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface FollowUpRow {
  readonly requestId: string;
  readonly userId: string;
  readonly subscriptionId: string;
  readonly status: CancellationStatus;
  readonly deadlineAt: Date | null;
  readonly lastNudgedAt: Date | null;
  readonly subscriptionName: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly intervalUnit: IntervalUnit;
  readonly intervalCount: number;
}

export type FollowUpSkipReason =
  | 'not_awaiting_confirmation'
  | 'no_deadline'
  | 'deadline_not_passed'
  | 'nudged_within_the_day';

export interface FollowUpSkip {
  readonly kind: 'skip';
  readonly requestId: string;
  readonly reason: FollowUpSkipReason;
}

export interface FollowUpNudge {
  readonly kind: 'nudge';
  readonly requestId: string;
  readonly userId: string;
  readonly subscriptionId: string;
  readonly at: Date;
  /** The machine's own `awaiting_confirmation --deadline_passed--> awaiting_confirmation`. */
  readonly describe: string;
  readonly notification: CancellationUnconfirmedInput;
}

export type FollowUpDecision = FollowUpSkip | FollowUpNudge;

export function planFollowUp(row: FollowUpRow, clock: Clock): FollowUpDecision {
  if (row.status !== 'awaiting_confirmation') {
    return { kind: 'skip', requestId: row.requestId, reason: 'not_awaiting_confirmation' };
  }
  if (row.deadlineAt === null) {
    // Nothing to be late for. A request with no deadline is one where the playbook could not
    // establish a notice period, and inventing one to chase against would be worse than silence.
    return { kind: 'skip', requestId: row.requestId, reason: 'no_deadline' };
  }

  const now = clock.now();
  if (now.getTime() < row.deadlineAt.getTime()) {
    return { kind: 'skip', requestId: row.requestId, reason: 'deadline_not_passed' };
  }
  if (
    row.lastNudgedAt !== null &&
    now.getTime() - row.lastNudgedAt.getTime() < NUDGE_INTERVAL_MS
  ) {
    return { kind: 'skip', requestId: row.requestId, reason: 'nudged_within_the_day' };
  }

  // Recorded through the machine even though the status does not move: the timeline entry says
  // "still unconfirmed past the deadline" in the machine's own words rather than this file's.
  const move = transitionCancellation(
    'awaiting_confirmation',
    'deadline_passed',
    'awaiting_confirmation',
  );

  return {
    kind: 'nudge',
    requestId: row.requestId,
    userId: row.userId,
    subscriptionId: row.subscriptionId,
    at: now,
    describe: move.describe,
    notification: {
      subscription: {
        subscriptionId: row.subscriptionId,
        name: row.subscriptionName,
        amount: money(row.amountMinor, row.currency),
        interval: interval(row.intervalUnit, row.intervalCount),
      },
      cancellationRequestId: row.requestId,
      deadlineAt: row.deadlineAt,
    },
  };
}

export function planFollowUps(rows: readonly FollowUpRow[], clock: Clock): FollowUpDecision[] {
  return rows.map((row) => planFollowUp(row, clock));
}

// ── IO ─────────────────────────────────────────────────────────────────────────────────

export interface FollowUpSummary {
  readonly examined: number;
  readonly nudged: number;
  readonly skipped: number;
  readonly notificationsQueued: number;
}

export async function runFollowUps(ctx: WorkerContext): Promise<FollowUpSummary> {
  const log = ctx.log.child({ job: 'follow-up' });
  const now = ctx.clock.now();

  const rows = await ctx.db
    .select({
      requestId: cancellationRequests.id,
      userId: cancellationRequests.userId,
      subscriptionId: cancellationRequests.subscriptionId,
      status: cancellationRequests.status,
      deadlineAt: cancellationRequests.deadlineAt,
      lastNudgedAt: cancellationRequests.lastNudgedAt,
      subscriptionName: subscriptions.displayName,
      amountMinor: subscriptions.amountMinor,
      currency: subscriptions.currency,
      intervalUnit: subscriptions.intervalUnit,
      intervalCount: subscriptions.intervalCount,
    })
    .from(cancellationRequests)
    .innerJoin(subscriptions, eq(cancellationRequests.subscriptionId, subscriptions.id))
    .where(
      and(
        eq(cancellationRequests.status, 'awaiting_confirmation'),
        isNotNull(cancellationRequests.deadlineAt),
        lte(cancellationRequests.deadlineAt, now),
      ),
    );

  const decisions = planFollowUps(rows, ctx.clock);
  const nudges = decisions.filter((decision): decision is FollowUpNudge => decision.kind === 'nudge');

  if (nudges.length === 0) {
    return { examined: rows.length, nudged: 0, skipped: decisions.length, notificationsQueued: 0 };
  }

  const prefs = await loadPreferences(ctx.db, nudges.map((nudge) => nudge.userId));
  let queued = 0;

  for (const nudge of nudges) {
    const userPrefs = prefs.get(nudge.userId);
    if (userPrefs !== undefined) {
      const requests = scheduleCancellationUnconfirmed(nudge.notification, userPrefs, ctx.clock);
      queued += (await persistNotifications(ctx.db, requests)).inserted;
    }

    // Stamped whether or not a notification was written. The stamp records that this job looked
    // at the row today; leaving it unset when the dedupe key already existed would have the job
    // re-examining the same request on every run for the rest of its life.
    await ctx.db.transaction(async (tx) => {
      const scope = new Scope(tx, nudge.userId);
      await tx
        .update(cancellationRequests)
        .set({ lastNudgedAt: nudge.at, updatedAt: nudge.at })
        .where(
          scope.whereId(
            cancellationRequests,
            nudge.requestId,
            eq(cancellationRequests.status, 'awaiting_confirmation'),
          ),
        );

      await tx.insert(cancellationEvents).values({
        requestId: nudge.requestId,
        at: nudge.at,
        actor: 'system',
        type: 'nudged',
        payload: {
          describe: nudge.describe,
          deadlineAt: nudge.notification.deadlineAt.toISOString(),
        },
      });
    });
  }

  log.info({ examined: rows.length, nudged: nudges.length, queued }, 'follow-up pass complete');

  return {
    examined: rows.length,
    nudged: nudges.length,
    skipped: decisions.length - nudges.length,
    notificationsQueued: queued,
  };
}
