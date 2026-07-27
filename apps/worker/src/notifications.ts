/**
 * Turning a scheduling decision into a row, and a row back into a decision.
 *
 * The insert is the load-bearing part of brief §8. `notifications.dedupe_key` is UNIQUE and this
 * file is the only place in the worker that writes the table, so "a user is never told the same
 * thing twice" reduces to one statement: `insert … on conflict do nothing`. No read-then-write,
 * because a read-then-write is a race and the race is won by whichever of two concurrently
 * running workers checked first. Both workers may insert; exactly one row survives; the loser
 * gets zero rows back and treats that as success, which it is.
 */

import {
  type NotificationChannel,
  type NotificationType,
  NOTIFICATION_CHANNELS,
} from '@ledger/core';
import { type Database, Scope, notifications } from '@ledger/db';
import type {
  NotificationPriority,
  NotificationRequest,
  NotificationRequestBase,
} from '@ledger/notify';

/**
 * Which channel the stored row is labelled with.
 *
 * One `NotificationRequest` becomes exactly one row — it has to, because `dedupe_key` is unique
 * across the whole table — while the request itself may fan out to three channels at send time.
 * The label matters anyway: the in-app inbox reads `channel = 'in_app'`, so a notification the
 * user opted to see in the app must be stored as `in_app` or it silently never appears there.
 */
export function primaryChannel(
  channels: readonly NotificationChannel[],
): NotificationChannel | null {
  if (channels.includes('in_app')) return 'in_app';
  return channels.find((channel) => NOTIFICATION_CHANNELS.includes(channel)) ?? null;
}

/** Mirrors `planRequest` in `@ledger/notify`: only the post-cancellation charge jumps the queue. */
export function priorityFor(type: NotificationType): NotificationPriority {
  return type === 'charged_after_cancellation' ? 'high' : 'normal';
}

export interface PersistResult {
  readonly attempted: number;
  readonly inserted: number;
  /** Requests that already existed. Not an error — it is the guarantee working. */
  readonly duplicates: number;
}

/**
 * Writes scheduled notifications, dropping the ones that already exist.
 *
 * Safe to call with requests spanning many users: each row is stamped through a `Scope` bound to
 * that request's own user, so there is no path where a `userId` is copied from anywhere but the
 * decision that produced it.
 */
export async function persistNotifications(
  db: Database,
  requests: readonly NotificationRequest[],
): Promise<PersistResult> {
  if (requests.length === 0) return { attempted: 0, inserted: 0, duplicates: 0 };

  // Collapsed before the insert as well as by the index. One pass can legitimately produce the
  // same request twice — a subscription joined to two open cancellation records, say — and while
  // `on conflict do nothing` tolerates in-statement duplicates, relying on that makes the row
  // count meaningless and the intent unclear.
  const seen = new Set<string>();
  const values = [];

  for (const request of requests) {
    if (seen.has(request.dedupeKey)) continue;
    seen.add(request.dedupeKey);

    const channel = primaryChannel(request.channels);
    // No channel means the user switched every one of them off. `channelsFor` normally catches
    // that upstream; this is the backstop, and dropping is correct — a row nobody can be sent
    // is a row the sender would pick up forever.
    if (channel === null) continue;

    const scope = new Scope(db, request.userId);
    values.push(
      scope.own({
        type: request.type,
        channel,
        subscriptionId: request.subscriptionId,
        scheduledFor: request.scheduledFor,
        deferredFrom: request.deferredFrom,
        dedupeKey: request.dedupeKey,
        payload: request.payload,
      }),
    );
  }

  if (values.length === 0) return { attempted: requests.length, inserted: 0, duplicates: 0 };

  const inserted = await db
    .insert(notifications)
    .values(values)
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id });

  return {
    attempted: requests.length,
    inserted: inserted.length,
    duplicates: values.length - inserted.length,
  };
}

// ── the other direction ────────────────────────────────────────────────────────────────

export interface StoredNotification {
  readonly id: string;
  readonly userId: string;
  readonly type: NotificationType;
  readonly channel: NotificationChannel;
  readonly subscriptionId: string | null;
  readonly scheduledFor: Date;
  readonly deferredFrom: Date | null;
  readonly dedupeKey: string;
  readonly payload: unknown;
  readonly attempts: number;
}

/**
 * Rebuilds the request the scheduler decided on, so the sender can render and deliver it.
 *
 * The channel list is supplied by the caller rather than read off the row, because the row can
 * only hold one and because a user who turned push off between the schedule and the send should
 * not get a push. The payload cast is the JSONB round trip: everything in a payload is declared
 * JSON-representable in `@ledger/notify`'s types precisely so this survives it.
 */
export function toNotificationRequest(
  row: StoredNotification,
  channels: readonly NotificationChannel[],
): NotificationRequest {
  const base: NotificationRequestBase = {
    userId: row.userId,
    dedupeKey: row.dedupeKey,
    scheduledFor: row.scheduledFor,
    deferredFrom: row.deferredFrom,
    channels,
    priority: priorityFor(row.type),
    subscriptionId: row.subscriptionId,
  };

  return { ...base, type: row.type, payload: row.payload } as NotificationRequest;
}
