/**
 * The sender — due rows out, notifications delivered.
 *
 * The scheduler decides; this drains. Keeping them apart is what makes the dedupe guarantee
 * work: by the time anything reaches this file the row already exists and already survived the
 * UNIQUE `dedupe_key`, so a sender that runs twice re-reads the same row rather than creating a
 * second one.
 *
 * Three things it will not do.
 *
 * **It will not retry forever.** `attempts` is incremented on every pass that fails to deliver,
 * and the query stops selecting a row once it hits the ceiling. A push endpoint that has been
 * dead for a week is not worth the slot it occupies, and a sender queue that keeps retrying dead
 * work is a sender queue that stops reaching the users who are still reachable.
 *
 * **It will not stamp `sent_at` on something it did not send.** A row where every channel was
 * skipped keeps its `last_error` and eventually falls out of the query. Marking it sent would put
 * it in the user's inbox as delivered, which is a lie the inbox has no way to correct.
 *
 * **It will not fan out without a bound.** `concurrency` caps deliveries in flight, so a backlog
 * drain cannot open two hundred simultaneous connections to a mail provider.
 */

import { and, asc, desc, eq, isNull, lte, lt, sql } from 'drizzle-orm';
import type { Clock, NotificationChannel } from '@ledger/core';
import { Scope, notifications, users } from '@ledger/db';
import {
  type ChannelOutcome,
  channelsFor,
  deliver,
  renderNotification,
} from '@ledger/notify';

import type { WorkerContext } from '../context';
import { loadPreferences } from '../preferences';
import { type StoredNotification, toNotificationRequest } from '../notifications';

export interface SendOutcome {
  /** True when at least one channel actually delivered. */
  readonly delivered: boolean;
  /** Null once delivered — a stale error on a sent row is a red herring in a support ticket. */
  readonly lastError: string | null;
  /** True when something transient failed and another pass could plausibly succeed. */
  readonly retryable: boolean;
}

/**
 * Folds the per-channel results into what gets written back to the row.
 *
 * `skipped` is not counted as a failure and not counted as a success. A user with no push
 * endpoints registered is a configuration fact; recording it as an error would make every such
 * row look broken, and recording it as delivery would claim a notification reached someone it
 * never touched.
 */
export function summarizeOutcomes(outcomes: readonly ChannelOutcome[]): SendOutcome {
  const delivered = outcomes.some((outcome) => outcome.result.status === 'sent');
  if (delivered) return { delivered: true, lastError: null, retryable: false };

  const problems = outcomes.map((outcome) => {
    const { channel, result } = outcome;
    switch (result.status) {
      case 'sent':
        return `${channel}: sent`;
      case 'skipped':
        return `${channel}: skipped (${result.reason})`;
      case 'failed':
        return `${channel}: failed (${result.reason})`;
    }
  });

  return {
    delivered: false,
    lastError: problems.length === 0 ? 'no channels to deliver on' : problems.join('; '),
    retryable: outcomes.some(
      (outcome) => outcome.result.status === 'failed' && outcome.result.retryable,
    ),
  };
}

export function isDue(row: { readonly scheduledFor: Date }, clock: Clock): boolean {
  return row.scheduledFor.getTime() <= clock.epochMillis();
}

export function hasAttemptsLeft(
  row: { readonly attempts: number },
  maxAttempts: number,
): boolean {
  return row.attempts < maxAttempts;
}

/** The rows this pass will try, in the order it will try them. */
export function selectDue<T extends { readonly scheduledFor: Date; readonly attempts: number }>(
  rows: readonly T[],
  clock: Clock,
  maxAttempts: number,
  limit: number,
): T[] {
  return rows
    .filter((row) => isDue(row, clock) && hasAttemptsLeft(row, maxAttempts))
    .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())
    .slice(0, limit);
}

/**
 * Runs `task` over `items` with at most `limit` in flight.
 *
 * Hand-rolled rather than pulled in: it is nine lines, and the alternative is a dependency in a
 * process that already has enough of them.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await task(item);
    }
  });

  await Promise.all(workers);
  return results;
}

// ── IO ─────────────────────────────────────────────────────────────────────────────────

export interface SenderSummary {
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
}

interface DueRow extends StoredNotification {
  readonly locale: string;
  readonly timeZone: string;
}

export async function runSender(ctx: WorkerContext): Promise<SenderSummary> {
  const log = ctx.log.child({ job: 'sender' });
  const now = ctx.clock.now();
  const maxAttempts = ctx.config.senderMaxAttempts;

  const rows: DueRow[] = await ctx.db
    .select({
      id: notifications.id,
      userId: notifications.userId,
      type: notifications.type,
      channel: notifications.channel,
      subscriptionId: notifications.subscriptionId,
      scheduledFor: notifications.scheduledFor,
      deferredFrom: notifications.deferredFrom,
      dedupeKey: notifications.dedupeKey,
      payload: notifications.payload,
      attempts: notifications.attempts,
      locale: users.locale,
      timeZone: users.timezone,
    })
    .from(notifications)
    .innerJoin(users, eq(notifications.userId, users.id))
    .where(
      and(
        isNull(notifications.sentAt),
        lte(notifications.scheduledFor, now),
        lt(notifications.attempts, maxAttempts),
        // A deleted account keeps its rows until the cascade job runs; mailing it in the
        // meantime is the one thing that cannot be taken back.
        isNull(users.deletedAt),
      ),
    )
    .orderBy(
      // The post-cancellation charge jumps the queue. A backlog of renewal reminders draining in
      // strict date order would put a time-sensitive alert behind a fortnight of routine ones.
      desc(sql`case when ${notifications.type} = 'charged_after_cancellation' then 1 else 0 end`),
      asc(notifications.scheduledFor),
    )
    .limit(ctx.config.senderBatchSize);

  if (rows.length === 0) return { claimed: 0, delivered: 0, failed: 0 };

  const prefs = await loadPreferences(ctx.db, rows.map((row) => row.userId));

  const outcomes = await mapWithConcurrency(rows, ctx.config.concurrency.sender, async (row) => {
    const userPrefs = prefs.get(row.userId);
    // Channels are re-derived at send time rather than read off the row: the row can only hold
    // one, and a user who switched push off since the schedule should not be pushed.
    const channels: readonly NotificationChannel[] =
      userPrefs === undefined ? [row.channel] : channelsFor(userPrefs, row.type);

    const request = toNotificationRequest(row, channels);

    try {
      const rendered = await renderNotification(request, {
        appUrl: ctx.renderDefaults.appUrl,
        locale: row.locale,
        timeZone: row.timeZone,
      });
      return { row, outcome: summarizeOutcomes(await deliver(request, rendered, ctx.channels)) };
    } catch (error) {
      // A template that throws is a bug in the template, not a transport problem, but it must
      // not take the rest of the batch with it.
      return {
        row,
        outcome: {
          delivered: false,
          lastError: `render failed: ${error instanceof Error ? error.message : 'unknown'}`,
          retryable: false,
        } satisfies SendOutcome,
      };
    }
  });

  let delivered = 0;
  let failed = 0;

  for (const { row, outcome } of outcomes) {
    if (outcome.delivered) delivered += 1;
    else failed += 1;

    await ctx.db
      .update(notifications)
      .set({
        attempts: row.attempts + 1,
        lastError: outcome.lastError,
        // `coalesce` rather than an assignment: `InAppChannel` may already have stamped this row
        // during the fan-out, and moving the timestamp forward would reorder an inbox under a
        // reader who had already seen the item.
        ...(outcome.delivered
          ? { sentAt: sql`coalesce(${notifications.sentAt}, ${ctx.clock.now()})` }
          : {}),
      })
      .where(new Scope(ctx.db, row.userId).whereId(notifications, row.id));

    if (!outcome.delivered && row.attempts + 1 >= maxAttempts) {
      log.warn(
        { notificationId: row.id, type: row.type, attempts: row.attempts + 1 },
        `giving up on this notification: ${outcome.lastError ?? 'unknown'}`,
      );
    }
  }

  log.info({ claimed: rows.length, delivered, failed }, 'sender pass complete');
  return { claimed: rows.length, delivered, failed };
}
