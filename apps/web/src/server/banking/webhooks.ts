import 'server-only';

import {
  type AggregatorAdapter,
  type WebhookEvent,
  type WebhookReceipt,
  type WebhookStore,
  REAUTH_ERROR_CODES,
  isAggregatorError,
  isRetryable,
  mapPlaidErrorCode,
  receiveWebhook,
} from '@ledger/banking';
import { type Clock, type ConnectionStatus } from '@ledger/core';
import { type Database, Scope, bankConnections } from '@ledger/db';
import { type Logger, childLogger } from '@ledger/logger';

/**
 * The web app's half of `@ledger/banking`'s webhook intake — the wire `receiveWebhook` was
 * written for.
 *
 * The shape mirrors `runtime.ts`: `receiveWebhook` owns verify → record → decide, and what lives
 * here is the HTTP translation plus the two side effects the receipt can ask for — an inline sync
 * and a status write. Both arrive as functions on `WebhookRuntime` rather than being imported,
 * because the route must return before the sync runs (Plaid times out at 10s) and *when* the
 * work runs is the caller's problem: the route defers through `after()`, and the tests run it
 * eagerly so they can assert a replay produced no second sync.
 *
 * The status codes are load-bearing. Plaid retries every non-2xx, so a 200 means exactly "stop
 * sending this delivery" — which is why a replay is 200 (already handled = success, not
 * conflict), an unknown event kind is 200 (Plaid adds webhook codes without notice), and an
 * unverified delivery is 401 (retrying it will never help and must not be encouraged).
 */

export interface WebhookRuntime {
  readonly adapter: AggregatorAdapter;
  readonly store: WebhookStore;
  readonly clock: Clock;
  /** Schedules work for after the response has been sent. The work never rejects. */
  readonly defer: (work: () => Promise<void>) => void;
  /** The inline sync, exactly as the tRPC mutations run it. */
  readonly sync: (userId: string, connectionId: string) => Promise<void>;
  /** Writes the connection status/error a verified ITEM-kind event implies. */
  readonly applyItemEvent: (
    userId: string,
    connectionId: string,
    event: WebhookEvent,
  ) => Promise<void>;
  readonly logger?: Logger;
}

/** The event kinds that change a connection's health rather than its data. */
const ITEM_EVENT_KINDS: readonly WebhookEvent['kind'][] = [
  'reauth_required',
  'consent_expiring',
  'item_removed',
  'error',
];

export async function handleWebhookRequest(
  runtime: WebhookRuntime,
  rawBody: string,
  headers: Readonly<Record<string, string | undefined>>,
): Promise<Response> {
  const log = runtime.logger ?? childLogger('web.webhooks');

  let receipt: WebhookReceipt;
  try {
    receipt = await receiveWebhook(
      { adapter: runtime.adapter, store: runtime.store, clock: runtime.clock, logger: log },
      rawBody,
      headers,
    );
  } catch (cause) {
    if (isAggregatorError(cause)) {
      // The message is one of the adapter's fixed sentences ("Signature does not verify.",
      // "Delivery is outside the replay window.") — the *reason*, never the body, which is
      // attacker-controlled precisely when this branch runs.
      log.warn(
        { provider: runtime.adapter.provider, code: cause.aggregatorCode, reason: cause.message },
        'rejected a webhook delivery',
      );
      return Response.json({ error: 'unverified' }, { status: 401 });
    }
    // Not a verification failure — the store misbehaved. Nothing was recorded, so a 500 makes
    // the aggregator redeliver into a working database rather than losing the event.
    log.error(
      { reason: cause instanceof Error ? cause.message : 'unknown' },
      'webhook intake failed before the delivery was recorded',
    );
    return Response.json({ error: 'intake_failed' }, { status: 500 });
  }

  const { event } = receipt;

  if (receipt.outcome === 'replay') {
    // A retransmission of a delivery we have already processed is success, not conflict — the
    // unique index made it a no-op, and any non-2xx here would just make Plaid retry forever.
    return Response.json({ received: true, replay: true });
  }

  if (receipt.outcome === 'unknown_connection') {
    // Recorded and normal: webhooks for a connection the user deleted keep arriving for a while.
    log.debug({ provider: event.provider, type: event.type }, 'webhook for an unknown connection');
    return Response.json({ received: true });
  }

  const { connectionId, userId } = receipt;

  if (connectionId !== null && userId !== null && ITEM_EVENT_KINDS.includes(event.kind)) {
    // One scoped UPDATE — cheap enough to run before responding, and it is the entire reason
    // /connections can surface "needs sign-in" before the next sync fails.
    await runtime.applyItemEvent(userId, connectionId, event);
    return Response.json({ received: true });
  }

  if (receipt.shouldSync && connectionId !== null && userId !== null) {
    runtime.defer(async () => {
      try {
        await runtime.sync(userId, connectionId);
      } catch (cause) {
        // Fully logged and stopped here: the aggregator was already answered, and a rejection
        // escaping a deferred task is an unhandled rejection.
        log.error(
          {
            connectionId,
            code: isAggregatorError(cause) ? cause.aggregatorCode : 'unknown',
            reason: cause instanceof Error ? cause.message : 'unknown',
          },
          'webhook-triggered sync failed',
        );
      }
    });
    return Response.json({ received: true, syncing: true });
  }

  // Verified, recorded, nothing to act on — including kinds this code has never heard of.
  // Debug, not warn: an unknown-but-verified event is Plaid shipping, not us breaking.
  log.debug(
    { provider: event.provider, type: event.type, kind: event.kind },
    'webhook recorded with nothing to do',
  );
  return Response.json({ received: true });
}

// ── the ITEM-kind status write ─────────────────────────────────────────────────────────

/**
 * Applies what an ITEM-kind event says about a connection, per `health.ts` semantics.
 *
 * The stored status can escalate and never quietly downgrades: nothing here ever writes
 * `active` — recovering a connection is what a successful sync or a re-link does, with evidence.
 * `consent_expiring` also refreshes `consent_expires_at` when the payload carries a deadline,
 * because the derived health on /connections counts days from that column, not from the status.
 */
export async function applyItemEvent(
  db: Database,
  clock: Clock,
  userId: string,
  connectionId: string,
  event: WebhookEvent,
): Promise<void> {
  const scope = new Scope(db, userId);
  const now = clock.now();
  const where = scope.whereId(bankConnections, connectionId);

  switch (event.kind) {
    case 'reauth_required':
      await db
        .update(bankConnections)
        .set({ status: 'reauth_required', updatedAt: now })
        .where(where);
      return;

    case 'item_removed':
      await db
        .update(bankConnections)
        .set({ status: 'disconnected', updatedAt: now })
        .where(where);
      return;

    case 'consent_expiring': {
      const expiresAt = readConsentExpiry(event.payload);
      await db
        .update(bankConnections)
        .set({
          status: 'consent_expiring',
          // Assigned conditionally: `exactOptionalPropertyTypes` distinguishes "leave the stored
          // deadline alone" (absent) from "erase it" (null), and an event with no timestamp
          // means the former.
          ...(expiresAt === null ? {} : { consentExpiresAt: expiresAt }),
          updatedAt: now,
        })
        .where(where);
      return;
    }

    case 'error': {
      const code = mapPlaidErrorCode(readErrorCode(event.payload));
      const status: ConnectionStatus = REAUTH_ERROR_CODES.includes(code)
        ? 'reauth_required'
        : code === 'consent_expired'
          ? 'consent_expired'
          : 'error';
      await db
        .update(bankConnections)
        .set({
          status,
          error: {
            code,
            // A fixed sentence rather than the payload's own message: the stored error is
            // rendered to the user, and upstream prose is not ours to promise.
            message: 'The aggregator reported a problem with this connection.',
            at: now.toISOString(),
            retryable: isRetryable(code),
          },
          updatedAt: now,
        })
        .where(where);
      return;
    }

    // Data-bearing kinds reach `sync`, never this function; listed so the switch stays
    // exhaustive and a new `WebhookKind` is a compile error here rather than a silent no-op.
    case 'sync_updates':
    case 'historical_ready':
    case 'other':
      return;
  }
}

// ── unknown-shape readers ──────────────────────────────────────────────────────────────

/** Plaid's ITEM error payload: `{ error: { error_code: 'ITEM_LOGIN_REQUIRED', … } }`. */
function readErrorCode(payload: Readonly<Record<string, unknown>>): string | null {
  const error = payload['error'];
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null;
  const code = (error as Record<string, unknown>)['error_code'];
  return typeof code === 'string' && code !== '' ? code : null;
}

/** Plaid's PENDING_EXPIRATION payload carries `consent_expiration_time` as an ISO string. */
function readConsentExpiry(payload: Readonly<Record<string, unknown>>): Date | null {
  const value = payload['consent_expiration_time'];
  if (typeof value !== 'string' || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
