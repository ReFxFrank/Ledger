/**
 * The sync engine — the Phase 5 acceptance criteria, written as tests.
 *
 * Everything here runs against `FixtureAdapter` and `MemorySyncStore`. There is no Postgres, and
 * that is the point: the properties being asserted are properties of the engine's decisions, and
 * an engine whose decisions can only be observed through a database is an engine nobody will
 * test on a laptop.
 */

import { describe, expect, it } from 'vitest';
import { FixedClock, parsePlainDate, toInstant } from '@ledger/core';
import { Keyring, keyFromBase64 } from '@ledger/crypto';
import { createLogger } from '@ledger/logger';

import type { AggregatorTransaction, SyncPage } from './adapter';
import { FixtureAdapter } from './fixture-adapter';
import { MemorySyncStore } from './memory-store';
import {
  type StoredAccount,
  type StoredDetection,
  type SyncContext,
  type SyncTarget,
  dedupeHashFor,
  planDetections,
  planPage,
  planSubscriptionLinks,
  preservedDetectionStatus,
  syncConnection,
} from './sync';

const NOW = '2026-07-20T09:00:00Z';
const USER = 'user-1';
const CONNECTION = 'conn-1';
const ITEM = 'fixture-item-test';

// Silent: these tests run a full 24-month sync several times and the log volume would bury the
// assertion that failed.
const logger = createLogger({ name: 'banking-test', level: 'silent' });

interface Harness {
  readonly context: SyncContext;
  readonly store: MemorySyncStore;
  readonly target: SyncTarget;
}

function harness(pageSize = 100): Harness {
  const clock = new FixedClock(NOW);
  const adapter = new FixtureAdapter({
    clock,
    keyring: new Keyring(keyFromBase64(Buffer.alloc(32, 5).toString('base64'))),
    seed: 4242,
    pageSize,
  });
  const store = new MemorySyncStore();
  store.seedConnection({ id: CONNECTION, userId: USER, provider: 'fixture', externalItemId: ITEM });

  return {
    context: { adapter, store, clock, logger },
    store,
    target: { userId: USER, connectionId: CONNECTION },
  };
}

function externalIds(store: MemorySyncStore): string[] {
  return store
    .listTransactions()
    .map((row) => row.externalId)
    .sort();
}

// ── idempotency ────────────────────────────────────────────────────────────────────────

describe('sync is idempotent', () => {
  it('inserts nothing on a second pass over the same feed', async () => {
    const { context, store, target } = harness();

    const first = await syncConnection(context, target);
    const afterFirst = store.transactionCount();
    const idsAfterFirst = externalIds(store);

    expect(first.inserted).toBeGreaterThan(500);
    expect(afterFirst).toBeGreaterThan(500);

    // Rewind to the beginning. Re-running from the persisted cursor would fetch an empty page
    // and prove nothing; replaying the entire feed is the only version of "run it twice" that
    // exercises both unique indexes.
    store.setCursor(CONNECTION, null);
    const second = await syncConnection(context, target);

    // The end state is byte-identical, which is what idempotency has to mean.
    expect(store.transactionCount()).toBe(afterFirst);
    expect(externalIds(store)).toEqual(idsAfterFirst);

    // Not literally zero inserts, and the exception is instructive: the only rows written again
    // are the two pre-authorizations, which the same replay retracts again a few pages later. A
    // retraction is an event in the feed, not a tombstone in our table, so replaying a feed that
    // contains one necessarily re-adds and re-removes the row. Nothing that survives the feed is
    // ever written twice.
    expect(second.inserted).toBe(second.removed);
    expect(second.inserted).toBe(2);
  });

  it('collapses the pending→posted re-issue instead of double-counting the charge', async () => {
    const { context, store, target } = harness();
    const result = await syncConnection(context, target);

    // Every dedupe fingerprint appears exactly once per account: that is the constraint the
    // re-issued authorization would have violated.
    const fingerprints = store.listTransactions().map((row) => `${row.accountId}|${row.dedupeHash}`);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);

    // The fixture re-issues four-odd charges; each pair produced exactly one row, and it is the
    // posted one.
    expect(store.listTransactions().some((row) => row.externalId.endsWith('-post'))).toBe(true);
    expect(store.listTransactions().some((row) => row.externalId.endsWith('-auth'))).toBe(false);

    // The pre-authorizations that never settled were delivered, then retracted, and are gone.
    expect(result.removed).toBe(2);
    expect(store.listTransactions().filter((row) => row.pending).length).toBe(0);
  });

  it('catches the re-issue even when the two halves arrive in different pages', async () => {
    // The page-level collapse in `planPage` handles the easy case. This is the case it cannot
    // see: the authorization committed days ago, the posted row turns up now, and the only
    // thing standing between the user and a doubled charge is the dedupe index.
    const { store } = harness();
    const accounts = await store.upsertAccounts(CONNECTION, [
      {
        externalId: 'ext-a',
        name: 'Checking',
        officialName: null,
        mask: '0000',
        type: 'depository',
        subtype: 'checking',
        currency: 'USD',
      },
    ]);
    const accountId = accounts.get('ext-a')?.id ?? '';
    const postedAt = parsePlainDate('2026-03-14');
    const shared = {
      accountId,
      postedAt: toInstant(postedAt, 'UTC'),
      authorizedAt: null,
      amountMinor: 1799,
      currency: 'USD',
      rawDescriptor: 'NETFLIX.COM',
      normalizedKey: 'NETFLIX',
      billingChannel: 'direct' as const,
      dedupeHash: dedupeHashFor(accountId, postedAt, 1799, 'NETFLIX'),
      raw: {},
    };

    const first = await store.commitPage({
      connectionId: CONNECTION,
      userId: USER,
      rows: [{ ...shared, externalId: 'txn-auth', pending: true }],
      removedExternalIds: [],
      cursor: 'fixture:v1:1',
      syncedAt: new Date(NOW),
    });
    const second = await store.commitPage({
      connectionId: CONNECTION,
      userId: USER,
      rows: [{ ...shared, externalId: 'txn-post', pending: false }],
      removedExternalIds: [],
      cursor: 'fixture:v1:2',
      syncedAt: new Date(NOW),
    });

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.settled).toBe(1);
    expect(store.transactionCount()).toBe(1);
    expect(store.listTransactions()[0]?.pending).toBe(false);
  });
});

// ── resumability ───────────────────────────────────────────────────────────────────────

describe('sync is resumable', () => {
  it('loses nothing and duplicates nothing when the worker dies mid-sync', async () => {
    // The reference: one clean run of the same corpus.
    const clean = harness(50);
    await syncConnection(clean.context, clean.target);
    const expectedIds = externalIds(clean.store);

    // The victim: killed immediately after page 3 commits — the worst case, because the cursor
    // has advanced and nobody told the queue.
    const killed = harness(50);
    killed.store.onPage = (pageIndex, phase) => {
      if (pageIndex === 3 && phase === 'after') throw new Error('worker killed');
    };

    await expect(syncConnection(killed.context, killed.target)).rejects.toThrow('worker killed');

    const partial = killed.store.transactionCount();
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(expectedIds.length);
    // The cursor survived, because it committed with the page rather than after it.
    expect(killed.store.connection(CONNECTION)?.cursor).not.toBeNull();

    killed.store.onPage = null;
    await syncConnection(killed.context, killed.target);

    expect(externalIds(killed.store)).toEqual(expectedIds);
  });

  it('replays the page it was in the middle of, without duplicating it', async () => {
    const clean = harness(50);
    await syncConnection(clean.context, clean.target);
    const expectedIds = externalIds(clean.store);

    const killed = harness(50);
    let attempts = 0;
    killed.store.onPage = (pageIndex, phase) => {
      // A crash *before* the commit: the transaction rolls back, so neither the rows nor the
      // cursor land, and the restart re-requests the same page.
      if (pageIndex === 2 && phase === 'before' && attempts === 0) {
        attempts += 1;
        throw new Error('killed mid-transaction');
      }
    };

    await expect(syncConnection(killed.context, killed.target)).rejects.toThrow(
      'killed mid-transaction',
    );
    const cursorAfterCrash = killed.store.connection(CONNECTION)?.cursor ?? null;

    await syncConnection(killed.context, killed.target);

    expect(externalIds(killed.store)).toEqual(expectedIds);
    expect(killed.store.connection(CONNECTION)?.cursor).not.toBe(cursorAfterCrash);
  });

  it('records the failure against the connection so health can see it', async () => {
    const { context, store, target } = harness(50);
    store.onPage = (pageIndex) => {
      if (pageIndex === 1) throw new Error('bank went away');
    };

    await expect(syncConnection(context, target)).rejects.toThrow('bank went away');
    expect(store.connectionError(CONNECTION)?.message).toBe('bank went away');

    store.onPage = null;
    await syncConnection(context, target);
    expect(store.connectionError(CONNECTION)).toBeNull();
  });
});

// ── backfill ───────────────────────────────────────────────────────────────────────────

describe('backfill', () => {
  it('marks completion only once the aggregator has run out of pages', async () => {
    const { context, store, target } = harness(50);

    const partial = await syncConnection(context, target, { maxPages: 2, reconcile: false });
    expect(partial.hasMore).toBe(true);
    expect(partial.backfillCompleted).toBe(false);
    expect(store.connection(CONNECTION)?.backfillCompletedAt).toBeNull();

    let guard = 0;
    let result = partial;
    while (result.hasMore && guard < 40) {
      result = await syncConnection(context, target, { maxPages: 2, reconcile: false });
      guard += 1;
    }

    expect(result.hasMore).toBe(false);
    expect(store.connection(CONNECTION)?.backfillCompletedAt).not.toBeNull();
  });

  it('does not re-stamp backfill completion on later syncs', async () => {
    const { context, target } = harness();
    const first = await syncConnection(context, target, { reconcile: false });
    expect(first.backfillCompleted).toBe(true);

    const second = await syncConnection(context, target, { reconcile: false });
    expect(second.backfillCompleted).toBe(false);
  });
});

// ── page planning ──────────────────────────────────────────────────────────────────────

describe('planPage', () => {
  const accounts = new Map<string, StoredAccount>([
    ['ext-a', { id: 'acct-a', externalId: 'ext-a', currency: 'USD', excludedFromDetection: null }],
  ]);

  function row(overrides: Partial<AggregatorTransaction>): AggregatorTransaction {
    return {
      externalId: 'txn-1',
      accountExternalId: 'ext-a',
      postedAt: parsePlainDate('2026-03-14'),
      authorizedAt: null,
      amountMinor: 1799,
      currency: 'USD',
      rawDescriptor: 'NETFLIX.COM',
      pending: false,
      raw: {},
      ...overrides,
    };
  }

  function page(added: AggregatorTransaction[], removed: string[] = []): Pick<SyncPage, 'added' | 'modified' | 'removed'> {
    return { added, modified: [], removed };
  }

  it('derives the normalized key and the billing channel for every row', () => {
    const plan = planPage(page([row({ rawDescriptor: 'APL*ICLOUD STORAGE' })]), accounts);
    expect(plan.rows[0]?.normalizedKey).toBe('ICLOUD STORAGE');
    expect(plan.rows[0]?.billingChannel).toBe('apple');
  });

  it('pins postedAt to UTC midnight so the same charge lands on one day for everyone', () => {
    const plan = planPage(page([row({})]), accounts);
    expect(plan.rows[0]?.postedAt.toISOString()).toBe(
      toInstant(parsePlainDate('2026-03-14'), 'UTC').toISOString(),
    );
  });

  it('lets the posted row win when an authorization and its re-issue share a page', () => {
    const plan = planPage(
      page([
        row({ externalId: 'txn-auth', pending: true }),
        row({ externalId: 'txn-posted', pending: false }),
      ]),
      accounts,
    );

    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]?.externalId).toBe('txn-posted');
    expect(plan.collapsedWithinPage).toBe(1);
  });

  it('wins the same way regardless of the order the aggregator serialised them in', () => {
    const plan = planPage(
      page([
        row({ externalId: 'txn-posted', pending: false }),
        row({ externalId: 'txn-auth', pending: true }),
      ]),
      accounts,
    );
    expect(plan.rows[0]?.externalId).toBe('txn-posted');
  });

  it('lets a modified row supersede the added row it revises', () => {
    const plan = planPage(
      {
        added: [row({ amountMinor: 1799 })],
        modified: [row({ amountMinor: 1899 })],
        removed: [],
      },
      accounts,
    );
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]?.amountMinor).toBe(1899);
  });

  it('counts rows for accounts we do not hold rather than throwing the page away', () => {
    const plan = planPage(page([row({ accountExternalId: 'ext-unknown' }), row({})]), accounts);
    expect(plan.rows).toHaveLength(1);
    expect(plan.skippedUnknownAccount).toBe(1);
  });

  it('dedupes retractions', () => {
    const plan = planPage(page([], ['a', 'a', 'b']), accounts);
    expect([...plan.removedExternalIds].sort()).toEqual(['a', 'b']);
  });
});

describe('dedupeHashFor', () => {
  it('is stable and account-local', () => {
    const date = parsePlainDate('2026-03-14');
    expect(dedupeHashFor('acct-a', date, 1799, 'NETFLIX')).toBe(
      dedupeHashFor('acct-a', date, 1799, 'NETFLIX'),
    );
    expect(dedupeHashFor('acct-b', date, 1799, 'NETFLIX')).not.toBe(
      dedupeHashFor('acct-a', date, 1799, 'NETFLIX'),
    );
  });

  it('keys on the normalized descriptor, because the re-issue rarely repeats the raw one', () => {
    const date = parsePlainDate('2026-03-14');
    expect(dedupeHashFor('acct-a', date, 1799, 'NETFLIX')).not.toBe(
      dedupeHashFor('acct-a', date, 1799, 'SPOTIFY'),
    );
  });
});

// ── detection reconciliation ───────────────────────────────────────────────────────────

describe('reconciliation', () => {
  it('finds the planted subscriptions and files them as pending', async () => {
    const { context, store, target } = harness();
    const result = await syncConnection(context, target);

    expect(result.detections?.candidates).toBeGreaterThan(8);
    const rows = await store.listDetections(USER);
    expect(rows.length).toBeGreaterThan(8);
    expect(rows.every((row) => row.status === 'pending')).toBe(true);
  });

  it('never reverts a confirmed detection to pending', async () => {
    const { context, store, target } = harness();
    await syncConnection(context, target);

    const answered = (await store.listDetections(USER))[0];
    expect(answered).toBeDefined();
    if (answered === undefined) return;

    store.setDetectionStatus(USER, answered.normalizedKey, answered.currency, 'confirmed', 'sub-1');

    // A full replay of the feed plus a fresh detection run — the most aggressive thing a later
    // sync can do to an existing row.
    store.setCursor(CONNECTION, null);
    await syncConnection(context, target);

    expect(store.detectionStatus(USER, answered.normalizedKey, answered.currency)).toBe('confirmed');
  });

  it('never reverts a dismissed detection either', async () => {
    const { context, store, target } = harness();
    await syncConnection(context, target);

    const answered = (await store.listDetections(USER))[1];
    expect(answered).toBeDefined();
    if (answered === undefined) return;

    store.setDetectionStatus(USER, answered.normalizedKey, answered.currency, 'dismissed');
    store.setCursor(CONNECTION, null);
    await syncConnection(context, target);

    expect(store.detectionStatus(USER, answered.normalizedKey, answered.currency)).toBe('dismissed');
  });

  it('stamps the transactions belonging to a confirmed subscription', async () => {
    const { context, store, target } = harness();
    await syncConnection(context, target);

    const confirmed = (await store.listDetections(USER)).find((row) => row.normalizedKey !== '');
    expect(confirmed).toBeDefined();
    if (confirmed === undefined) return;

    store.setDetectionStatus(USER, confirmed.normalizedKey, confirmed.currency, 'confirmed', 'sub-9');
    const result = await syncConnection(context, target);

    expect(result.detections?.linkedTransactions).toBeGreaterThan(0);
    const stamped = store
      .listTransactions()
      .filter((row) => row.subscriptionId === 'sub-9');
    expect(stamped.length).toBeGreaterThan(0);
    expect(stamped.every((row) => row.normalizedKey === confirmed.normalizedKey)).toBe(true);
  });

  it('does not stamp anything for a detection the user has not confirmed', () => {
    const pending: StoredDetection[] = [
      { id: 'd1', normalizedKey: 'NETFLIX', currency: 'USD', status: 'pending', subscriptionId: null },
      { id: 'd2', normalizedKey: 'SPOTIFY', currency: 'USD', status: 'confirmed', subscriptionId: null },
      { id: 'd3', normalizedKey: 'HULU', currency: 'USD', status: 'confirmed', subscriptionId: 'sub-3' },
    ];
    expect(planSubscriptionLinks(pending)).toEqual([
      { normalizedKey: 'HULU', currency: 'USD', subscriptionId: 'sub-3' },
    ]);
  });
});

describe('planDetections', () => {
  it('has no way to express a status change', () => {
    // A structural assertion, not a behavioural one: the reason a sync cannot un-answer a
    // question is that `DetectionWrite` has no field for the answer.
    expect(preservedDetectionStatus('confirmed')).toBe('confirmed');
    expect(preservedDetectionStatus('dismissed')).toBe('dismissed');
    expect(preservedDetectionStatus('merged')).toBe('merged');
    expect(preservedDetectionStatus(null)).toBe('pending');
  });

  it('separates new keys from ones the user has already answered', () => {
    const existing: StoredDetection[] = [
      { id: 'd1', normalizedKey: 'NETFLIX', currency: 'USD', status: 'dismissed', subscriptionId: null },
    ];
    const plan = planDetections(
      [
        candidate('NETFLIX', 'USD'),
        candidate('SPOTIFY', 'USD'),
        // A cluster whose descriptor reduced to nothing cannot be unique on anything.
        candidate('', 'USD'),
      ],
      existing,
    );

    expect(plan.writes.map((write) => write.normalizedKey)).toEqual(['NETFLIX', 'SPOTIFY']);
    expect(plan.newKeys).toEqual(['SPOTIFY|USD']);
    expect(plan.preservedKeys).toEqual(['NETFLIX|USD']);
  });
});

// ── helpers ────────────────────────────────────────────────────────────────────────────

function candidate(normalizedKey: string, currencyCode: string): Parameters<typeof planDetections>[0][number] {
  return {
    id: `${normalizedKey}:${currencyCode}`,
    normalizedKey,
    merchantMatch: { merchantId: null, matchedVia: 'none', score: 0 },
    channel: 'direct',
    interval: { unit: 'month', count: 1 },
    medianAmountMinor: 1799,
    currency: currencyCode,
    amountCv: 0,
    occurrences: 6,
    firstSeen: parsePlainDate('2026-01-14'),
    lastSeen: parsePlainDate('2026-06-14'),
    nextExpectedAt: parsePlainDate('2026-07-14'),
    confidence: 0.9,
    status: 'active',
    accountIds: ['acct-a'],
    variableAmount: false,
    isTrial: false,
    trialEndsAt: null,
    priceChange: null,
    transactionIds: ['t1'],
    gapDays: [30, 31, 30, 31, 30],
    confidenceFactors: { cadence: 0.5 },
    sampleDescriptors: ['NETFLIX.COM'],
  };
}
