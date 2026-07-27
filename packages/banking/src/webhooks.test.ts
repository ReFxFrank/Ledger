/**
 * Webhook intake.
 *
 * The replay test is the one that matters. Aggregators retry on every timeout, and a retry that
 * re-runs a sync is at best duplicated work and at worst — before the sync engine was idempotent
 * — duplicated transactions. The unique index on `(provider, external_id)` is the whole guard,
 * so the test asserts the *second* delivery does nothing rather than that the first one worked.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '@ledger/core';
import { Keyring, keyFromBase64 } from '@ledger/crypto';
import { createLogger } from '@ledger/logger';

import { FixtureAdapter } from './fixture-adapter';
import { MemorySyncStore } from './memory-store';
import { type WebhookContext, receiveWebhook, shouldSyncFor } from './webhooks';

const SECRET = 'fixture-webhook-secret';
const ITEM = 'fixture-item-hook';
const logger = createLogger({ name: 'banking-test', level: 'silent' });

function harness(): { context: WebhookContext; store: MemorySyncStore } {
  const clock = new FixedClock('2026-07-20T09:00:00Z');
  const adapter = new FixtureAdapter({
    clock,
    keyring: new Keyring(keyFromBase64(Buffer.alloc(32, 9).toString('base64'))),
    webhookSecret: SECRET,
  });
  const store = new MemorySyncStore();
  store.seedConnection({
    id: 'conn-1',
    userId: 'user-1',
    provider: 'fixture',
    externalItemId: ITEM,
  });

  return { context: { adapter, store, clock, logger }, store };
}

function sign(body: string): Record<string, string> {
  return {
    'X-Fixture-Signature': createHash('sha256').update(`${SECRET}.${body}`, 'utf8').digest('hex'),
  };
}

function delivery(id: string, type = 'sync_updates', itemId: string = ITEM): string {
  return JSON.stringify({ id, type, item_id: itemId, new_transactions: 4 });
}

describe('receiveWebhook', () => {
  it('accepts a verified delivery and asks for a sync', async () => {
    const { context, store } = harness();
    const body = delivery('delivery-1');

    const receipt = await receiveWebhook(context, body, sign(body));

    expect(receipt.outcome).toBe('accepted');
    expect(receipt.shouldSync).toBe(true);
    expect(receipt.connectionId).toBe('conn-1');
    expect(receipt.userId).toBe('user-1');
    expect(store.deliveryCount()).toBe(1);
  });

  it('ignores a replayed delivery', async () => {
    const { context, store } = harness();
    const body = delivery('delivery-1');
    const headers = sign(body);

    const first = await receiveWebhook(context, body, headers);
    const second = await receiveWebhook(context, body, headers);
    const third = await receiveWebhook(context, body, headers);

    expect(first.outcome).toBe('accepted');
    expect(second.outcome).toBe('replay');
    expect(third.outcome).toBe('replay');
    // The guard is the row, not a flag in memory: only one delivery was ever recorded.
    expect(store.deliveryCount()).toBe(1);
    expect(second.shouldSync).toBe(false);
    expect(third.shouldSync).toBe(false);
  });

  it('treats a genuinely new delivery as new even when it says the same thing', async () => {
    const { context, store } = harness();

    const first = delivery('delivery-1');
    const second = delivery('delivery-2');
    await receiveWebhook(context, first, sign(first));
    const receipt = await receiveWebhook(context, second, sign(second));

    expect(receipt.outcome).toBe('accepted');
    expect(store.deliveryCount()).toBe(2);
  });

  it('refuses an unsigned or mis-signed delivery before reading a single field', async () => {
    const { context, store } = harness();
    const body = delivery('delivery-1');

    await expect(receiveWebhook(context, body, {})).rejects.toThrow(/Signature/);
    await expect(
      receiveWebhook(context, body, { 'x-fixture-signature': 'deadbeef' }),
    ).rejects.toThrow(/Signature/);

    // Nothing was recorded, so a rejected delivery cannot poison the replay guard for the real
    // one that follows it.
    expect(store.deliveryCount()).toBe(0);
    const accepted = await receiveWebhook(context, body, sign(body));
    expect(accepted.outcome).toBe('accepted');
  });

  it('records a delivery for an unknown item without asking for a sync', async () => {
    const { context, store } = harness();
    const body = delivery('delivery-1', 'sync_updates', 'fixture-item-someone-else');

    const receipt = await receiveWebhook(context, body, sign(body));

    expect(receipt.outcome).toBe('unknown_connection');
    expect(receipt.shouldSync).toBe(false);
    // Still recorded: a webhook for a connection we deleted is normal, and answering 500 to it
    // just makes the aggregator redeliver forever.
    expect(store.deliveryCount()).toBe(1);
  });

  it('records an informational event without syncing', async () => {
    const { context } = harness();
    const body = delivery('delivery-1', 'consent_expiring');

    const receipt = await receiveWebhook(context, body, sign(body));

    expect(receipt.outcome).toBe('ignored');
    expect(receipt.shouldSync).toBe(false);
    expect(receipt.event.kind).toBe('consent_expiring');
  });

  it('rejects a body that is not JSON', async () => {
    const { context } = harness();
    const body = 'not json';
    await expect(receiveWebhook(context, body, sign(body))).rejects.toThrow(/not JSON/);
  });
});

describe('shouldSyncFor', () => {
  it('syncs on new data and on nothing else', () => {
    expect(shouldSyncFor('sync_updates')).toBe(true);
    expect(shouldSyncFor('historical_ready')).toBe(true);
    expect(shouldSyncFor('reauth_required')).toBe(false);
    expect(shouldSyncFor('consent_expiring')).toBe(false);
    expect(shouldSyncFor('item_removed')).toBe(false);
    expect(shouldSyncFor('other')).toBe(false);
  });
});
