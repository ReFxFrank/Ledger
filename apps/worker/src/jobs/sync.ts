/**
 * Per-connection sync.
 *
 * The engine itself lives in `@ledger/banking` and is not reimplemented here — this file is the
 * queue's half of the contract: decide how hard to try again, and tell the user when trying again
 * will not help.
 *
 * That distinction is the whole point of `classifySyncFailure`. A bank having a bad five minutes
 * and a user who revoked consent both surface as "sync failed", and treating them the same is how
 * a queue spends ten exponential retries on a connection that will never work again — while the
 * user, who could fix it in thirty seconds by re-authenticating, is told nothing. So terminal
 * failures fail the job immediately via `UnrecoverableError`, and only the ones a person can act
 * on produce an email.
 *
 * Killing this worker mid-sync is safe: the cursor is written in the same Postgres transaction as
 * the page it describes, so a restart resumes from the last committed page and re-plays at most
 * one page against `ON CONFLICT DO NOTHING`. Safe is not the same as free, though, which is why
 * the shutdown path drains rather than aborts.
 */

import { UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import {
  type AggregatorErrorCode,
  type SyncResult,
  isAggregatorError,
  syncConnection,
} from '@ledger/banking';
import type { Clock } from '@ledger/core';
import { Scope, bankConnections } from '@ledger/db';
import { scheduleSyncFailed } from '@ledger/notify';

import type { WorkerContext } from '../context';
import { loadPreferences } from '../preferences';
import { persistNotifications } from '../notifications';
import { type Queues, type SyncJobData, type SyncReason, syncJobId } from '../queues';

/**
 * How long a connection must have been failing before the user hears about it.
 *
 * A transient upstream failure resolves itself on the next run and an email about it is noise
 * that trains people to ignore the ones that matter. Six hours is roughly two failed hourly
 * cycles plus backoff — long enough to be a real outage, short enough that a user notices before
 * their dashboard is a day stale.
 */
export const NOTIFY_AFTER_FAILING_MS = 6 * 60 * 60 * 1000;

/** Codes where retrying cannot help. The link is revoked, expired, gone, or misconfigured. */
export const TERMINAL_ERROR_CODES: readonly AggregatorErrorCode[] = [
  'reauth_required',
  'consent_expired',
  'item_not_found',
  'not_configured',
  'invalid_webhook',
];

/** Terminal failures the *user* can actually resolve. `not_configured` is ours, not theirs. */
export const USER_ACTIONABLE_ERROR_CODES: readonly AggregatorErrorCode[] = [
  'reauth_required',
  'consent_expired',
  'item_not_found',
];

/** The `{ code, message, at, retryable }` object stored on `bank_connections.error`. */
export interface StoredConnectionError {
  readonly code: string;
  readonly message: string;
  readonly at: string;
  readonly retryable: boolean;
}

export interface SyncFailureDecision {
  readonly code: string;
  readonly message: string;
  readonly terminal: boolean;
  readonly notifyUser: boolean;
  /**
   * The first day of *this* failing run, not the day we noticed.
   *
   * `scheduleSyncFailed` builds its dedupe key from this date, so carrying it forward from the
   * error already on the row is what turns a connection that has been broken for a week into one
   * email rather than seven.
   */
  readonly failingSince: Date;
}

/** Recovers the start of the current failing run from whatever was on the row. */
export function resolveFailingSince(previous: StoredConnectionError | null, now: Date): Date {
  if (previous === null) return now;
  const parsed = new Date(previous.at);
  // A row written by an older version, or hand-edited during an incident, must not produce an
  // `Invalid Date` that then formats into a dedupe key.
  if (Number.isNaN(parsed.getTime())) return now;
  return parsed;
}

export function classifySyncFailure(
  cause: unknown,
  previous: StoredConnectionError | null,
  clock: Clock,
): SyncFailureDecision {
  const now = clock.now();
  const failingSince = resolveFailingSince(previous, now);

  if (isAggregatorError(cause)) {
    const terminal = TERMINAL_ERROR_CODES.includes(cause.aggregatorCode);
    const actionable = USER_ACTIONABLE_ERROR_CODES.includes(cause.aggregatorCode);
    return {
      code: cause.aggregatorCode,
      message: cause.message,
      terminal,
      notifyUser:
        actionable || (!terminal && now.getTime() - failingSince.getTime() >= NOTIFY_AFTER_FAILING_MS),
      failingSince,
    };
  }

  // Anything that is not an `AggregatorError` came from our own code or the driver, and both
  // recover. Only the message is carried: an upstream error object holds the request that
  // produced it, and that request holds an access token.
  return {
    code: 'upstream',
    message: cause instanceof Error ? cause.message : 'Sync failed for an unknown reason.',
    terminal: false,
    notifyUser: now.getTime() - failingSince.getTime() >= NOTIFY_AFTER_FAILING_MS,
    failingSince,
  };
}

// ── enqueueing ─────────────────────────────────────────────────────────────────────────

/**
 * Enqueues a sync, collapsing duplicates.
 *
 * A webhook, a manual refresh, and a scheduled run can all land on one connection within a
 * second of each other. `syncJobId` gives all three the same id inside a five-minute bucket, so
 * BullMQ keeps the first and drops the rest.
 */
export async function enqueueSync(
  queues: Queues,
  clock: Clock,
  data: SyncJobData,
): Promise<string | null> {
  const job = await queues.sync.add('sync', data, { jobId: syncJobId(data.connectionId, clock) });
  return job.id ?? null;
}

// ── IO ─────────────────────────────────────────────────────────────────────────────────

export async function runSync(ctx: WorkerContext, data: SyncJobData): Promise<SyncResult | null> {
  const log = ctx.log.child({ job: 'sync', connectionId: data.connectionId });
  const scope = new Scope(ctx.db, data.userId);

  const [connection] = await ctx.db
    .select({
      institutionName: bankConnections.institutionName,
      error: bankConnections.error,
    })
    .from(bankConnections)
    .where(scope.whereId(bankConnections, data.connectionId))
    .limit(1);

  if (connection === undefined) {
    // Disconnected between the enqueue and now. Not a failure worth retrying and not worth an
    // alert — the user asked for it to be gone.
    log.info('connection no longer exists; nothing to sync');
    return null;
  }

  // Captured before the run, because `syncConnection` overwrites `bank_connections.error` on its
  // way out and the previous value is what dates the current failing run.
  const previousError = connection.error ?? null;

  const registry = await ctx.registry.get();

  try {
    const result = await syncConnection(
      {
        adapter: ctx.adapter,
        store: ctx.syncStore,
        clock: ctx.clock,
        // Omitted rather than passed as undefined: `exactOptionalPropertyTypes` distinguishes
        // the two, and `SyncContext.registry` means "use none" only when absent.
        ...(registry === null ? {} : { registry }),
        logger: log,
      },
      { userId: data.userId, connectionId: data.connectionId },
    );

    // `syncConnection` clears `bank_connections.error` itself on success, in the same place it
    // writes it on failure — so success and failure can never disagree about the row.
    if (result.hasMore) {
      // The page budget ran out, not the aggregator. Re-enqueue rather than holding this worker
      // for the length of an entire 24-month backfill.
      await enqueueContinuation(ctx, data);
    }

    log.info(
      { pages: result.pages, inserted: result.inserted, hasMore: result.hasMore },
      'sync run finished',
    );
    return result;
  } catch (cause) {
    const decision = classifySyncFailure(cause, previousError, ctx.clock);

    if (decision.notifyUser) {
      await announceFailure(ctx, data.userId, data.connectionId, connection.institutionName, decision);
    }

    log.error(
      { code: decision.code, terminal: decision.terminal, notified: decision.notifyUser },
      decision.message,
    );

    if (decision.terminal) {
      // Stops BullMQ retrying. A revoked consent is not worth ten attempts, and the exponential
      // backoff would keep the job alive for hours after the answer became "ask the user".
      throw new UnrecoverableError(`${decision.code}: ${decision.message}`);
    }
    throw cause;
  }
}

/**
 * Re-enqueues the same connection for its next page.
 *
 * A distinct reason and a fresh bucket, so a continuation is never collapsed into the job that
 * produced it — that would stall a backfill at whatever page the bucket boundary happened to
 * fall on.
 */
async function enqueueContinuation(ctx: WorkerContext, data: SyncJobData): Promise<void> {
  const reason: SyncReason = 'continuation';
  await ctx.queues.sync.add(
    'sync',
    { ...data, reason },
    { jobId: `sync:${data.connectionId}:continue:${String(ctx.clock.epochMillis())}` },
  );
}

async function announceFailure(
  ctx: WorkerContext,
  userId: string,
  connectionId: string,
  institutionName: string,
  decision: SyncFailureDecision,
): Promise<void> {
  const prefs = (await loadPreferences(ctx.db, [userId])).get(userId);
  if (prefs === undefined) return;

  const requests = scheduleSyncFailed(
    { connectionId, institutionName, failingSince: decision.failingSince },
    prefs,
    ctx.clock,
  );
  await persistNotifications(ctx.db, requests);
}

/**
 * Enqueues a sync for every connection that is not already known to be broken.
 *
 * Used by the hourly scheduler tick. Connections in a terminal state are skipped rather than
 * retried on a timer — the row already says what the user has to do, and re-running the sync
 * cannot change the answer.
 */
export async function enqueueScheduledSyncs(ctx: WorkerContext): Promise<number> {
  const rows = await ctx.db
    .select({ id: bankConnections.id, userId: bankConnections.userId })
    .from(bankConnections)
    .where(eq(bankConnections.status, 'active'));

  for (const row of rows) {
    await enqueueSync(ctx.queues, ctx.clock, {
      userId: row.userId,
      connectionId: row.id,
      reason: 'scheduled',
    });
  }
  return rows.length;
}
