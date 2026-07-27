/**
 * Webhook intake.
 *
 * The order of operations is the whole design: **verify, then record, then act.**
 *
 * Verify first because an unverified delivery has no fields worth reading — not the item id, not
 * the type, nothing. Record second because the unique index on `(provider, external_id)` is the
 * replay guard, and a guard that runs after the work it is guarding is not a guard. Act last,
 * and only if the insert actually took: an aggregator that retries a delivery it already sent —
 * which every aggregator does, on every timeout — must produce a no-op, not a second sync.
 *
 * Nothing here enqueues anything. `@ledger/banking` has no queue dependency and should not grow
 * one; `receiveWebhook` returns what happened and the worker decides what to do about it. That
 * also means the replay test in this package is a real test of the guard rather than a test of a
 * queue mock.
 */

import type { Clock } from '@ledger/core';
import { childLogger, type Logger } from '@ledger/logger';

import {
  type AggregatorAdapter,
  type WebhookEvent,
  type WebhookKind,
  isAggregatorError,
} from './adapter';

/** One row bound for `webhook_deliveries`. */
export interface WebhookDelivery {
  readonly provider: string;
  readonly externalId: string;
  readonly itemId: string | null;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly receivedAt: Date;
}

export type RecordOutcome = 'recorded' | 'duplicate';

export interface WebhookStore {
  /**
   * Inserts the delivery, or reports that it was already there.
   *
   * Must be a single `INSERT … ON CONFLICT DO NOTHING RETURNING` — checking for existence first
   * and inserting second loses the race to a concurrent redelivery, which is exactly the
   * scenario a retry storm produces.
   */
  recordDelivery(delivery: WebhookDelivery): Promise<RecordOutcome>;
  markProcessed(provider: string, externalId: string, at: Date): Promise<void>;
  /** Resolves the aggregator's link id to a local connection. `null` for an unknown item. */
  findConnectionByItem(
    provider: string,
    externalItemId: string,
  ): Promise<{ readonly id: string; readonly userId: string } | null>;
}

export interface WebhookContext {
  readonly adapter: AggregatorAdapter;
  readonly store: WebhookStore;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export type WebhookOutcome =
  /** Verified, newly recorded, and worth acting on. */
  | 'accepted'
  /** Verified, but this exact delivery has already been handled. Do nothing. */
  | 'replay'
  /** Verified and recorded, but nothing to do — an informational event. */
  | 'ignored'
  /** Verified and recorded, but it refers to a link we do not hold. */
  | 'unknown_connection';

export interface WebhookReceipt {
  readonly outcome: WebhookOutcome;
  readonly event: WebhookEvent;
  readonly connectionId: string | null;
  readonly userId: string | null;
  /** True when the caller should enqueue a sync for `connectionId`. */
  readonly shouldSync: boolean;
}

/** Which events mean "there is new data to pull". */
export function shouldSyncFor(kind: WebhookKind): boolean {
  return kind === 'sync_updates' || kind === 'historical_ready';
}

/**
 * Verifies a delivery, records it, and reports what the caller should do.
 *
 * Throws only when verification fails — the caller should answer 4xx and, importantly, *not*
 * retry. Everything else is a receipt, including "this refers to a connection we do not have",
 * because a webhook for a deleted connection is normal and answering 500 to it just makes the
 * aggregator redeliver forever.
 */
export async function receiveWebhook(
  context: WebhookContext,
  rawBody: string,
  headers: Readonly<Record<string, string | undefined>>,
): Promise<WebhookReceipt> {
  const log = context.logger ?? childLogger('banking.webhooks');

  let event: WebhookEvent;
  try {
    event = await context.adapter.handleWebhook(rawBody, headers);
  } catch (cause) {
    // Logged at warn rather than error: an unverified delivery is usually a scanner, and paging
    // someone at 3am for a scanner is how alerting gets muted.
    log.warn(
      {
        provider: context.adapter.provider,
        code: isAggregatorError(cause) ? cause.aggregatorCode : 'invalid_webhook',
      },
      'rejected an unverified webhook delivery',
    );
    throw cause;
  }

  const receivedAt = context.clock.now();
  const outcome = await context.store.recordDelivery({
    provider: event.provider,
    externalId: event.externalId,
    itemId: event.itemExternalId,
    type: event.type,
    payload: event.payload,
    receivedAt,
  });

  if (outcome === 'duplicate') {
    log.info(
      { provider: event.provider, type: event.type, deliveryId: event.externalId },
      'ignored a replayed webhook delivery',
    );
    return { outcome: 'replay', event, connectionId: null, userId: null, shouldSync: false };
  }

  const connection =
    event.itemExternalId === null
      ? null
      : await context.store.findConnectionByItem(event.provider, event.itemExternalId);

  await context.store.markProcessed(event.provider, event.externalId, receivedAt);

  if (connection === null) {
    return {
      outcome: 'unknown_connection',
      event,
      connectionId: null,
      userId: null,
      shouldSync: false,
    };
  }

  const sync = shouldSyncFor(event.kind);
  return {
    outcome: sync ? 'accepted' : 'ignored',
    event,
    connectionId: connection.id,
    userId: connection.userId,
    shouldSync: sync,
  };
}
