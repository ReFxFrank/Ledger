/**
 * The webhook route's HTTP translation, against the FixtureAdapter.
 *
 * `receiveWebhook` already has its own suite in @ledger/banking; what is under test here is what
 * the route adds on top — the status codes and the deferral. The three that matter: an
 * unverified delivery is 401 and records nothing, a replay is 200 and runs no second sync
 * (Plaid retries on non-2xx, so answering a retry with anything else redelivers forever), and an
 * unknown-but-verified kind is 200 because Plaid adds webhook codes without notice.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type WebhookEvent, FixtureAdapter, MemorySyncStore } from '@ledger/banking';
import { FixedClock } from '@ledger/core';
import { createLogger } from '@ledger/logger';
import { type WebhookRuntime, handleWebhookRequest } from '~/server/banking/webhooks';

const SECRET = 'route-webhook-secret';
const ITEM = 'fixture-item-route';

interface Harness {
  readonly runtime: WebhookRuntime;
  readonly store: MemorySyncStore;
  readonly syncs: { userId: string; connectionId: string }[];
  readonly itemEvents: { connectionId: string; kind: WebhookEvent['kind'] }[];
  /** Waits for everything `defer` scheduled, the way the runtime would after responding. */
  flush(): Promise<void>;
}

function harness(options: { failSync?: boolean } = {}): Harness {
  const clock = new FixedClock('2026-07-20T09:00:00Z');
  const adapter = new FixtureAdapter({ clock, webhookSecret: SECRET });
  const store = new MemorySyncStore();
  store.seedConnection({
    id: 'conn-1',
    userId: 'user-1',
    provider: 'fixture',
    externalItemId: ITEM,
  });

  const syncs: { userId: string; connectionId: string }[] = [];
  const itemEvents: { connectionId: string; kind: WebhookEvent['kind'] }[] = [];
  const deferred: Promise<void>[] = [];

  const runtime: WebhookRuntime = {
    adapter,
    store,
    clock,
    logger: createLogger({ name: 'web-webhooks-test', level: 'silent' }),
    // Eager rather than after-response: the tests need to await the deferred work to assert on
    // it, and the contract — `defer` receives work that cannot reject — is the same either way.
    defer: (work) => {
      deferred.push(work());
    },
    sync: (userId, connectionId) => {
      if (options.failSync === true) return Promise.reject(new Error('sync exploded'));
      syncs.push({ userId, connectionId });
      return Promise.resolve();
    },
    applyItemEvent: (userId, connectionId, event) => {
      itemEvents.push({ connectionId, kind: event.kind });
      return Promise.resolve();
    },
  };

  return {
    runtime,
    store,
    syncs,
    itemEvents,
    flush: async () => {
      await Promise.all(deferred);
    },
  };
}

function sign(body: string): Record<string, string> {
  return {
    'x-fixture-signature': createHash('sha256').update(`${SECRET}.${body}`, 'utf8').digest('hex'),
  };
}

function delivery(id: string, type = 'sync_updates', itemId: string = ITEM): string {
  return JSON.stringify({ id, type, item_id: itemId });
}

describe('handleWebhookRequest', () => {
  it('rejects an unverified delivery with 401 and records nothing', async () => {
    const h = harness();
    const body = delivery('delivery-1');

    const unsigned = await handleWebhookRequest(h.runtime, body, {});
    const misSigned = await handleWebhookRequest(h.runtime, body, {
      'x-fixture-signature': 'deadbeef',
    });

    expect(unsigned.status).toBe(401);
    expect(misSigned.status).toBe(401);
    // Nothing recorded, nothing synced: an unverified body has no fields worth reading.
    expect(h.store.deliveryCount()).toBe(0);
    expect(h.syncs).toHaveLength(0);
  });

  it('syncs once on a verified delivery and answers 200', async () => {
    const h = harness();
    const body = delivery('delivery-1');

    const response = await handleWebhookRequest(h.runtime, body, sign(body));
    await h.flush();

    expect(response.status).toBe(200);
    expect(h.syncs).toEqual([{ userId: 'user-1', connectionId: 'conn-1' }]);
    expect(h.store.deliveryCount()).toBe(1);
  });

  it('answers 200 to a replay without running a second sync', async () => {
    const h = harness();
    const body = delivery('delivery-1');
    const headers = sign(body);

    const first = await handleWebhookRequest(h.runtime, body, headers);
    const second = await handleWebhookRequest(h.runtime, body, headers);
    await h.flush();

    expect(first.status).toBe(200);
    // 200, not 409: a retried delivery we have already processed is success, and any non-2xx
    // just makes the aggregator send it again.
    expect(second.status).toBe(200);
    expect(h.syncs).toHaveLength(1);
    expect(h.store.deliveryCount()).toBe(1);
  });

  it('records an unknown-but-verified kind and answers 200', async () => {
    const h = harness();
    const body = delivery('delivery-1', 'SOME_CODE_PLAID_ADDED_LAST_TUESDAY');

    const response = await handleWebhookRequest(h.runtime, body, sign(body));
    await h.flush();

    expect(response.status).toBe(200);
    expect(h.store.deliveryCount()).toBe(1);
    expect(h.syncs).toHaveLength(0);
    expect(h.itemEvents).toHaveLength(0);
  });

  it('applies an ITEM-kind event to the connection instead of syncing', async () => {
    const h = harness();
    const body = delivery('delivery-1', 'reauth_required');

    const response = await handleWebhookRequest(h.runtime, body, sign(body));
    await h.flush();

    expect(response.status).toBe(200);
    expect(h.itemEvents).toEqual([{ connectionId: 'conn-1', kind: 'reauth_required' }]);
    expect(h.syncs).toHaveLength(0);
  });

  it('answers 200 for a verified delivery about a connection we do not hold', async () => {
    const h = harness();
    const body = delivery('delivery-1', 'sync_updates', 'fixture-item-somebody-else');

    const response = await handleWebhookRequest(h.runtime, body, sign(body));
    await h.flush();

    // Still recorded — a webhook for a deleted connection is normal — and never synced.
    expect(response.status).toBe(200);
    expect(h.store.deliveryCount()).toBe(1);
    expect(h.syncs).toHaveLength(0);
  });

  it('contains a failing deferred sync instead of surfacing a rejection', async () => {
    const h = harness({ failSync: true });
    const body = delivery('delivery-1');

    const response = await handleWebhookRequest(h.runtime, body, sign(body));

    expect(response.status).toBe(200);
    // The deferred work swallowed the failure; if it had not, this await would reject.
    await expect(h.flush()).resolves.toBeUndefined();
  });
});
