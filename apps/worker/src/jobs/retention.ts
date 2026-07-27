/**
 * Retention — dropping the raw bank feed once it has stopped being useful.
 *
 * `transactions` is the table that gets large: 50k rows per user is the load target, and the feed
 * is the least valuable thing in the database per byte. Everything derived from it —
 * subscriptions, detections, price history, the cancellation timeline — is small, permanent, and
 * untouched by this job. Brief §4.4 is explicit that a subscription is archived, never deleted;
 * the same is true of a detection, whose whole purpose is to remember a question the user already
 * answered.
 *
 * So the purge is deliberately narrow: rows in `transactions` older than the retention window,
 * and nothing else. Two exceptions are enforced here rather than left to a foreign key:
 *
 *  - A transaction cited as `cancellation_requests.charged_after_cancellation_tx_id` is evidence.
 *    Its foreign key is `on delete set null`, so purging it would not error — it would quietly
 *    empty the one field a user needs when they take a post-cancellation charge to their bank.
 *    That is exactly the kind of data loss that looks like nothing went wrong.
 *  - The cutoff is calendar arithmetic on a `PlainDate`, not `now − N × 30 days`. "Twenty-four
 *    months" is a wall-clock statement, and month lengths are not a rounding detail at that scale.
 *
 * The planner is pure and works over a snapshot, so "the purge removes raw transactions and
 * leaves subscriptions and detections" is a test rather than an assurance.
 */

import { and, inArray, isNotNull, lt } from 'drizzle-orm';
import { type Clock, addMonths, fromInstant, toInstant } from '@ledger/core';
import { cancellationRequests, transactions } from '@ledger/db';

import type { WorkerContext } from '../context';

/** How many ids one delete statement carries. Bounded so a first purge cannot lock the table. */
export const PURGE_BATCH_SIZE = 5_000;

export interface PurgeableTransaction {
  readonly id: string;
  readonly postedAt: Date;
}

export interface RetainedDetection {
  readonly id: string;
  /** Transaction ids cited as evidence. Kept as-is; a dangling id is not a reason to delete a row. */
  readonly evidenceTransactionIds: readonly string[];
}

export interface RetentionSnapshot {
  readonly transactions: readonly PurgeableTransaction[];
  readonly detections: readonly RetainedDetection[];
  readonly subscriptions: readonly { readonly id: string }[];
  /** Transactions cited as `charged_after_cancellation_tx_id`. Never purged. */
  readonly evidenceTransactionIds: readonly string[];
}

export interface RetentionPlan {
  readonly cutoff: Date;
  readonly retentionMonths: number;
  readonly deleteTransactionIds: readonly string[];
  /** Old enough to purge, kept anyway because a cancellation record points at them. */
  readonly retainedAsEvidence: readonly string[];
}

/** The instant before which a raw transaction is no longer kept. */
export function retentionCutoff(retentionMonths: number, clock: Clock): Date {
  return toInstant(addMonths(fromInstant(clock.now(), 'UTC'), -retentionMonths), 'UTC');
}

export function planRetention(
  snapshot: RetentionSnapshot,
  retentionMonths: number,
  clock: Clock,
): RetentionPlan {
  const cutoff = retentionCutoff(retentionMonths, clock);
  const evidence = new Set(snapshot.evidenceTransactionIds);

  const deleteTransactionIds: string[] = [];
  const retainedAsEvidence: string[] = [];

  for (const row of snapshot.transactions) {
    if (row.postedAt.getTime() >= cutoff.getTime()) continue;
    if (evidence.has(row.id)) {
      retainedAsEvidence.push(row.id);
      continue;
    }
    deleteTransactionIds.push(row.id);
  }

  return { cutoff, retentionMonths, deleteTransactionIds, retainedAsEvidence };
}

/**
 * Applies a plan to a snapshot.
 *
 * Exists so the property that matters — that nothing but `transactions` is touched — can be
 * asserted on the result rather than inferred from the absence of a statement.
 */
export function applyRetentionPlan(
  snapshot: RetentionSnapshot,
  plan: RetentionPlan,
): RetentionSnapshot {
  const doomed = new Set(plan.deleteTransactionIds);
  return {
    ...snapshot,
    transactions: snapshot.transactions.filter((row) => !doomed.has(row.id)),
  };
}

// ── IO ─────────────────────────────────────────────────────────────────────────────────

export interface RetentionSummary {
  readonly cutoff: string;
  readonly retentionMonths: number;
  readonly deleted: number;
  readonly retainedAsEvidence: number;
  readonly batches: number;
}

export async function runRetention(ctx: WorkerContext): Promise<RetentionSummary> {
  const log = ctx.log.child({ job: 'retention' });
  const months = ctx.config.retentionMonths;
  const cutoff = retentionCutoff(months, ctx.clock);

  // Read once: the set is bounded by the number of failed cancellations, which is small, and
  // re-reading it per batch would let a cancellation recorded mid-purge protect a row the
  // previous batch already removed.
  const evidenceRows = await ctx.db
    .select({ id: cancellationRequests.chargedAfterCancellationTxId })
    .from(cancellationRequests)
    .where(isNotNull(cancellationRequests.chargedAfterCancellationTxId));
  const evidence = new Set(
    evidenceRows.flatMap((row) => (row.id === null ? [] : [row.id])),
  );

  let deleted = 0;
  let batches = 0;
  // A set, not a counter: an evidence row stays below the cutoff and is re-selected by every
  // subsequent batch, so counting occurrences would report the same handful of rows repeatedly.
  const retained = new Set<string>();

  for (;;) {
    const candidates = await ctx.db
      .select({ id: transactions.id, postedAt: transactions.postedAt })
      .from(transactions)
      .where(lt(transactions.postedAt, cutoff))
      .limit(PURGE_BATCH_SIZE);

    if (candidates.length === 0) break;

    const plan = planRetention(
      {
        transactions: candidates,
        detections: [],
        subscriptions: [],
        evidenceTransactionIds: [...evidence],
      },
      months,
      ctx.clock,
    );

    for (const id of plan.retainedAsEvidence) retained.add(id);
    batches += 1;

    if (plan.deleteTransactionIds.length === 0) {
      // Everything left below the cutoff is evidence. Another pass would return the same rows
      // forever, so stop rather than spin.
      break;
    }

    const removed = await ctx.db
      .delete(transactions)
      .where(
        and(
          inArray(transactions.id, [...plan.deleteTransactionIds]),
          lt(transactions.postedAt, cutoff),
        ),
      )
      .returning({ id: transactions.id });

    deleted += removed.length;
    if (candidates.length < PURGE_BATCH_SIZE) break;
  }

  const summary: RetentionSummary = {
    cutoff: cutoff.toISOString(),
    retentionMonths: months,
    deleted,
    retainedAsEvidence: retained.size,
    batches,
  };
  log.info(summary, 'retention purge complete');
  return summary;
}
