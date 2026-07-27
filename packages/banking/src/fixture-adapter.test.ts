/**
 * The fixture adapter.
 *
 * These tests exist because everything else in the package is measured against this corpus. If
 * the fixture is not deterministic, every downstream test is measuring the fixture rather than
 * the engine; if it does not page, the resumability test is a no-op that passes.
 */

import { describe, expect, it } from 'vitest';
import { FixedClock, parsePlainDate } from '@ledger/core';
import { Keyring, keyFromBase64, open } from '@ledger/crypto';
import { normalizeDescriptor } from '@ledger/detection';

import type { AggregatorConnection, AggregatorTransaction, SyncPage } from './adapter';
import { accessTokenAad } from './adapter';
import { FixtureAdapter, buildCorpus } from './fixture-adapter';

const NOW = '2026-07-20T09:00:00Z';

function keyring(): Keyring {
  return new Keyring(keyFromBase64(Buffer.alloc(32, 3).toString('base64')));
}

function adapter(overrides: { seed?: number; pageSize?: number } = {}): FixtureAdapter {
  return new FixtureAdapter({
    clock: new FixedClock(NOW),
    keyring: keyring(),
    seed: overrides.seed ?? 1234,
    pageSize: overrides.pageSize ?? 100,
  });
}

async function connect(instance: FixtureAdapter): Promise<AggregatorConnection> {
  const linked = await instance.exchangeToken('public-fixture-1');
  return {
    id: 'conn-1',
    provider: linked.provider,
    externalItemId: linked.externalItemId,
    accessTokenCiphertext: linked.accessTokenCiphertext,
    keyId: linked.keyId,
  };
}

async function drain(
  instance: FixtureAdapter,
  connection: AggregatorConnection,
): Promise<{ rows: AggregatorTransaction[]; pages: SyncPage[] }> {
  const rows: AggregatorTransaction[] = [];
  const pages: SyncPage[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const page: SyncPage = await instance.syncTransactions(connection, cursor);
    pages.push(page);
    rows.push(...page.added);
    cursor = page.nextCursor;
    hasMore = page.hasMore;
  }

  return { rows, pages };
}

describe('the fixture corpus', () => {
  it('is deterministic from the seed and the clock', async () => {
    const first = await drain(adapter(), await connect(adapter()));
    const second = await drain(adapter(), await connect(adapter()));

    expect(first.rows.map((row) => row.externalId)).toEqual(second.rows.map((row) => row.externalId));
    expect(first.rows.map((row) => row.amountMinor)).toEqual(second.rows.map((row) => row.amountMinor));
  });

  it('gives a different seed a different household', () => {
    const today = parsePlainDate('2026-07-20');
    const a = buildCorpus(1, today);
    const b = buildCorpus(2, today);
    const amounts = (corpus: ReturnType<typeof buildCorpus>): number[] =>
      corpus.events.flatMap((event) => (event.added === null ? [] : [event.added.amountMinor]));

    expect(amounts(a)).not.toEqual(amounts(b));
  });

  it('serves two years across two accounts in two currencies', async () => {
    const instance = adapter();
    const connection = await connect(instance);
    const { rows } = await drain(instance, connection);

    const accounts = await instance.getAccounts(connection);
    expect(accounts.map((account) => account.currency).sort()).toEqual(['EUR', 'USD']);

    const currencies = new Set(rows.map((row) => row.currency));
    expect(currencies).toEqual(new Set(['USD', 'EUR']));

    const dates = rows.map((row) => row.postedAt.year * 12 + row.postedAt.month);
    expect(Math.max(...dates) - Math.min(...dates)).toBeGreaterThanOrEqual(23);
  });

  it('contains recurring series a user would recognise', async () => {
    const instance = adapter();
    const { rows } = await drain(instance, await connect(instance));

    const keys = new Set(rows.map((row) => normalizeDescriptor(row.rawDescriptor).normalized));
    for (const expected of ['NETFLIX', 'SPOTIFY', 'PLANET FITNESS', '1PASSWORD']) {
      expect([...keys].some((key) => key.includes(expected))).toBe(true);
    }
  });

  it('carries the billing channels that change where a user has to cancel', async () => {
    const instance = adapter();
    const { rows } = await drain(instance, await connect(instance));

    const channels = new Set(rows.map((row) => normalizeDescriptor(row.rawDescriptor).channel));
    expect(channels.has('apple')).toBe(true);
    expect(channels.has('paypal')).toBe(true);
  });

  it('includes money arriving, signed negative', async () => {
    const instance = adapter();
    const { rows } = await drain(instance, await connect(instance));

    const inflows = rows.filter((row) => row.amountMinor < 0);
    expect(inflows.length).toBeGreaterThan(20);
    expect(inflows.every((row) => row.rawDescriptor.includes('PAYROLL'))).toBe(true);

    // And everything that is not an inflow is a charge. If the sign convention were inverted
    // anywhere in generation, this is the assertion that would fail.
    const charges = rows.filter((row) => row.amountMinor > 0);
    expect(charges.length).toBeGreaterThan(rows.length / 2);
  });

  it('re-issues some pending charges under a second id, to exercise the dedupe backstop', async () => {
    const instance = adapter();
    const { rows } = await drain(instance, await connect(instance));

    const pending = rows.filter((row) => row.externalId.endsWith('-auth'));
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((row) => row.pending)).toBe(true);

    for (const authorization of pending) {
      const posted = rows.find(
        (row) =>
          !row.pending &&
          row.accountExternalId === authorization.accountExternalId &&
          row.amountMinor === authorization.amountMinor &&
          row.postedAt.year === authorization.postedAt.year &&
          row.postedAt.month === authorization.postedAt.month &&
          row.postedAt.day === authorization.postedAt.day,
      );
      expect(posted).toBeDefined();
      expect(posted?.externalId).not.toBe(authorization.externalId);
    }
  });

  it('retracts the pre-authorizations that never settled', async () => {
    const instance = adapter();
    const { rows, pages } = await drain(instance, await connect(instance));

    const removed = pages.flatMap((page) => page.removed);
    expect(removed.length).toBe(2);
    // Every retraction names a row the feed actually delivered earlier — a retraction for
    // something we never saw would silently do nothing and hide a bug in the sync engine.
    const delivered = new Set(rows.map((row) => row.externalId));
    expect(removed.every((externalId) => delivered.has(externalId))).toBe(true);
  });
});

describe('paging and cursors', () => {
  it('pages, and every page but the last reports more', async () => {
    const instance = adapter({ pageSize: 50 });
    const { pages } = await drain(instance, await connect(instance));

    expect(pages.length).toBeGreaterThan(5);
    expect(pages.slice(0, -1).every((page) => page.hasMore)).toBe(true);
    expect(pages[pages.length - 1]?.hasMore).toBe(false);
  });

  it('resumes from a cursor with exactly the rows that follow it', async () => {
    const instance = adapter({ pageSize: 50 });
    const connection = await connect(instance);

    const first = await instance.syncTransactions(connection, null);
    const second = await instance.syncTransactions(connection, first.nextCursor);
    // Re-requesting the same cursor returns the same page — the cursor is a position, not a
    // consumed queue entry, which is what makes a crashed worker safe to restart.
    const secondAgain = await instance.syncTransactions(connection, first.nextCursor);

    expect(second.added.map((row) => row.externalId)).toEqual(
      secondAgain.added.map((row) => row.externalId),
    );
    const firstIds = new Set(first.added.map((row) => row.externalId));
    expect(second.added.some((row) => firstIds.has(row.externalId))).toBe(false);
  });

  it('rejects a cursor it did not issue', async () => {
    const instance = adapter();
    const connection = await connect(instance);
    await expect(instance.syncTransactions(connection, 'plaid-cursor-abc')).rejects.toThrow(
      /not issued by this adapter/,
    );
  });
});

describe('the link flow', () => {
  it('returns the access token sealed, never in the clear', async () => {
    const ring = keyring();
    const instance = new FixtureAdapter({ clock: new FixedClock(NOW), keyring: ring, seed: 7 });

    const linked = await instance.exchangeToken('public-fixture-1');

    expect(Object.keys(linked)).not.toContain('accessToken');
    expect(linked.accessTokenCiphertext).not.toContain('fixture-access');
    expect(
      open(
        ring,
        { keyId: linked.keyId, ciphertext: linked.accessTokenCiphertext },
        accessTokenAad('fixture', linked.externalItemId),
      ),
    ).toContain('fixture-access');
  });

  it('reports a consent deadline, so the health rules have something to derive from', async () => {
    const instance = adapter();
    const linked = await instance.exchangeToken('public-fixture-1');
    expect(linked.consentExpiresAt).not.toBeNull();
    expect(linked.consentExpiresAt?.getTime()).toBeGreaterThan(new Date(NOW).getTime());
  });

  it('stops serving a connection that has been removed', async () => {
    const instance = adapter();
    const connection = await connect(instance);
    await instance.removeConnection(connection);
    await expect(instance.syncTransactions(connection, null)).rejects.toThrow(/has been removed/);
  });
});
