/**
 * An in-memory `SyncStore` + `WebhookStore`.
 *
 * This exists because the Phase 5 acceptance criteria — sync is idempotent, a webhook replay is
 * ignored, a killed worker resumes without loss or duplication — are properties of the *engine*,
 * and testing them against a live Postgres would mean they only get tested where a live Postgres
 * exists. They would then not be tested on a laptop, which is where the bugs are written.
 *
 * The only thing that makes this a fair test rather than a comfortable one is that it enforces
 * the same two unique constraints the real schema does:
 *
 *   - `transactions_external_unique` on `external_id`
 *   - `transactions_dedupe_unique` on `(account_id, dedupe_hash)`
 *
 * and the same "sync never writes a detection's status" rule. Where `store.ts` says `ON CONFLICT
 * DO NOTHING`, this says "the map already has that key". If those two ever disagree, the
 * disagreement is a bug in one of them and not in the test.
 *
 * `commitPage` also models transactionality: nothing is mutated until every row has been
 * resolved, so a failure injected through `onPage('before')` leaves the store exactly as it was —
 * including the cursor, which is the point.
 */

import type { DetectionStatus } from '@ledger/core';
import type { DetectionTransaction } from '@ledger/detection';

import type { AggregatorAccount } from './adapter';
import {
  type CommitPageInput,
  type CommitPageResult,
  type ConnectionFailure,
  type DetectionWrite,
  type DetectionWriteResult,
  type FinishSyncInput,
  type StoredAccount,
  type StoredConnection,
  type StoredDetection,
  type SubscriptionLink,
  type SyncStore,
  preservedDetectionStatus,
  toDetectionTransaction,
} from './sync';
import type { RecordOutcome, WebhookDelivery, WebhookStore } from './webhooks';

export interface MemoryConnectionSeed {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly externalItemId: string;
  readonly accessTokenCiphertext?: string;
  readonly keyId?: string;
  readonly consentExpiresAt?: Date | null;
}

interface MutableConnection {
  id: string;
  userId: string;
  provider: string;
  externalItemId: string;
  accessTokenCiphertext: string;
  keyId: string;
  cursor: string | null;
  status: StoredConnection['status'];
  consentExpiresAt: Date | null;
  backfillCompletedAt: Date | null;
  lastSyncedAt: Date | null;
  error: ConnectionFailure | null;
}

interface MutableAccount {
  id: string;
  connectionId: string;
  externalId: string;
  currency: string;
  excludedFromDetection: Date | null;
}

export interface MemoryTransaction {
  readonly id: string;
  readonly accountId: string;
  externalId: string;
  postedAt: Date;
  authorizedAt: Date | null;
  amountMinor: number;
  currency: string;
  rawDescriptor: string;
  normalizedKey: string;
  billingChannel: string;
  pending: boolean;
  readonly dedupeHash: string;
  raw: Readonly<Record<string, unknown>>;
  subscriptionId: string | null;
}

interface MutableDetection {
  id: string;
  userId: string;
  normalizedKey: string;
  currency: string;
  status: DetectionStatus;
  subscriptionId: string | null;
  write: DetectionWrite;
}

/** Injected failure point. `phase` is 'before' for a crash mid-page, 'after' for one just past it. */
export type PageHook = (pageIndex: number, phase: 'before' | 'after') => void;

export class MemorySyncStore implements SyncStore, WebhookStore {
  private readonly connections = new Map<string, MutableConnection>();
  private readonly accounts = new Map<string, MutableAccount>();
  private readonly transactionsByExternalId = new Map<string, MemoryTransaction>();
  private readonly transactionsByDedupe = new Map<string, MemoryTransaction>();
  private readonly detections = new Map<string, MutableDetection>();
  private readonly deliveries = new Map<string, WebhookDelivery & { processedAt: Date | null }>();

  private sequence = 0;
  private pagesCommitted = 0;

  /** Set by a test to simulate a worker dying at a chosen point. */
  onPage: PageHook | null = null;

  seedConnection(seed: MemoryConnectionSeed): StoredConnection {
    const connection: MutableConnection = {
      id: seed.id,
      userId: seed.userId,
      provider: seed.provider,
      externalItemId: seed.externalItemId,
      accessTokenCiphertext: seed.accessTokenCiphertext ?? 'sealed',
      keyId: seed.keyId ?? 'test-key',
      cursor: null,
      status: 'active',
      consentExpiresAt: seed.consentExpiresAt ?? null,
      backfillCompletedAt: null,
      lastSyncedAt: null,
      error: null,
    };
    this.connections.set(connection.id, connection);
    return snapshot(connection);
  }

  // ── SyncStore ────────────────────────────────────────────────────────────────────────

  loadConnection(userId: string, connectionId: string): Promise<StoredConnection | null> {
    const connection = this.connections.get(connectionId);
    // The user check is not decoration: it is the in-memory stand-in for `Scope`, and dropping
    // it here would make a cross-user test pass against this store and fail against the real one.
    if (connection?.userId !== userId) return Promise.resolve(null);
    return Promise.resolve(snapshot(connection));
  }

  upsertAccounts(
    connectionId: string,
    accounts: readonly AggregatorAccount[],
  ): Promise<ReadonlyMap<string, StoredAccount>> {
    const result = new Map<string, StoredAccount>();
    for (const account of accounts) {
      const existing = [...this.accounts.values()].find(
        (candidate) =>
          candidate.connectionId === connectionId && candidate.externalId === account.externalId,
      );
      const row: MutableAccount = existing ?? {
        id: this.mint('acct'),
        connectionId,
        externalId: account.externalId,
        currency: account.currency,
        excludedFromDetection: null,
      };
      row.currency = account.currency;
      this.accounts.set(row.id, row);
      result.set(account.externalId, {
        id: row.id,
        externalId: row.externalId,
        currency: row.currency,
        excludedFromDetection: row.excludedFromDetection,
      });
    }
    return Promise.resolve(result);
  }

  commitPage(input: CommitPageInput): Promise<CommitPageResult> {
    const pageIndex = this.pagesCommitted;
    // Before any mutation, so a throw here is indistinguishable from a rolled-back transaction.
    this.onPage?.(pageIndex, 'before');

    const connection = this.connections.get(input.connectionId);
    if (connection === undefined) throw new Error(`Unknown connection ${input.connectionId}`);

    const inserts: MemoryTransaction[] = [];
    const updates: (() => void)[] = [];
    let updated = 0;
    let settled = 0;

    const stagedByExternalId = new Set<string>();
    const stagedByDedupe = new Set<string>();

    for (const row of input.rows) {
      const dedupeKey = `${row.accountId}|${row.dedupeHash}`;
      const existing = this.transactionsByExternalId.get(row.externalId);

      if (existing !== undefined) {
        // Same external id: a redelivery or a revision. Mutable columns only — `external_id`,
        // `account_id`, and `dedupe_hash` are the identity and are never rewritten. Letting the
        // hash move would let one corrected amount collide with an unrelated row and abort the
        // whole page, which is a worse outcome than a fingerprint that describes the first
        // sighting.
        updated += 1;
        updates.push(() => {
          existing.postedAt = row.postedAt;
          existing.authorizedAt = row.authorizedAt;
          existing.amountMinor = row.amountMinor;
          existing.currency = row.currency;
          existing.rawDescriptor = row.rawDescriptor;
          existing.normalizedKey = row.normalizedKey;
          existing.billingChannel = row.billingChannel;
          existing.pending = row.pending;
          existing.raw = row.raw;
        });
        continue;
      }

      const collision = this.transactionsByDedupe.get(dedupeKey);
      if (collision !== undefined) {
        // The pending → posted re-issue. The charge is already recorded under its authorization
        // id; a second row would double the user's spend for that merchant.
        if (collision.pending && !row.pending) {
          settled += 1;
          updates.push(() => {
            collision.pending = false;
            collision.authorizedAt = row.authorizedAt;
          });
        }
        continue;
      }

      if (stagedByExternalId.has(row.externalId) || stagedByDedupe.has(dedupeKey)) continue;
      stagedByExternalId.add(row.externalId);
      stagedByDedupe.add(dedupeKey);

      inserts.push({
        id: this.mint('txn'),
        accountId: row.accountId,
        externalId: row.externalId,
        postedAt: row.postedAt,
        authorizedAt: row.authorizedAt,
        amountMinor: row.amountMinor,
        currency: row.currency,
        rawDescriptor: row.rawDescriptor,
        normalizedKey: row.normalizedKey,
        billingChannel: row.billingChannel,
        pending: row.pending,
        dedupeHash: row.dedupeHash,
        raw: row.raw,
        subscriptionId: null,
      });
    }

    const connectionAccounts = new Set(
      [...this.accounts.values()]
        .filter((account) => account.connectionId === input.connectionId)
        .map((account) => account.id),
    );
    const retractions = input.removedExternalIds
      .map((externalId) => this.transactionsByExternalId.get(externalId))
      .filter(
        (row): row is MemoryTransaction => row !== undefined && connectionAccounts.has(row.accountId),
      );

    // ── commit ──
    for (const apply of updates) apply();
    for (const row of inserts) {
      this.transactionsByExternalId.set(row.externalId, row);
      this.transactionsByDedupe.set(`${row.accountId}|${row.dedupeHash}`, row);
    }
    for (const row of retractions) {
      this.transactionsByExternalId.delete(row.externalId);
      this.transactionsByDedupe.delete(`${row.accountId}|${row.dedupeHash}`);
    }
    connection.cursor = input.cursor;
    connection.lastSyncedAt = input.syncedAt;
    this.pagesCommitted += 1;

    // After the commit: a crash here must leave the cursor advanced, which is what makes the
    // resume test meaningful rather than a re-run of the same page.
    this.onPage?.(pageIndex, 'after');

    return Promise.resolve({
      inserted: inserts.length,
      updated,
      settled,
      removed: retractions.length,
    });
  }

  finishSync(input: FinishSyncInput): Promise<void> {
    const connection = this.connections.get(input.connectionId);
    if (connection !== undefined) {
      connection.lastSyncedAt = input.syncedAt;
      if (input.backfillCompletedAt !== null) {
        connection.backfillCompletedAt = input.backfillCompletedAt;
      }
    }
    return Promise.resolve();
  }

  recordFailure(connectionId: string, failure: ConnectionFailure): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (connection !== undefined) connection.error = failure;
    return Promise.resolve();
  }

  clearFailure(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (connection !== undefined) connection.error = null;
    return Promise.resolve();
  }

  loadDetectionInput(userId: string): Promise<readonly DetectionTransaction[]> {
    const accountIds = new Set(
      [...this.accounts.values()]
        .filter((account) => {
          if (account.excludedFromDetection !== null) return false;
          return this.connections.get(account.connectionId)?.userId === userId;
        })
        .map((account) => account.id),
    );

    const rows = [...this.transactionsByExternalId.values()]
      .filter((row) => accountIds.has(row.accountId))
      .map((row) => toDetectionTransaction(row));

    return Promise.resolve(rows);
  }

  listDetections(userId: string): Promise<readonly StoredDetection[]> {
    return Promise.resolve(
      [...this.detections.values()]
        .filter((row) => row.userId === userId)
        .map((row) => ({
          id: row.id,
          normalizedKey: row.normalizedKey,
          currency: row.currency,
          status: row.status,
          subscriptionId: row.subscriptionId,
        })),
    );
  }

  writeDetections(userId: string, writes: readonly DetectionWrite[]): Promise<DetectionWriteResult> {
    let inserted = 0;
    let updated = 0;

    for (const write of writes) {
      const key = `${userId}|${write.normalizedKey}|${write.currency}`;
      const existing = this.detections.get(key);
      if (existing === undefined) {
        this.detections.set(key, {
          id: this.mint('det'),
          userId,
          normalizedKey: write.normalizedKey,
          currency: write.currency,
          status: preservedDetectionStatus(null),
          subscriptionId: null,
          write,
        });
        inserted += 1;
        continue;
      }
      // The evidence moves; the answer does not. `status` is not in `DetectionWrite` at all, so
      // there is nothing here that could overwrite it even by accident.
      existing.write = write;
      existing.status = preservedDetectionStatus(existing.status);
      updated += 1;
    }

    return Promise.resolve({ inserted, updated });
  }

  linkSubscriptions(userId: string, links: readonly SubscriptionLink[]): Promise<number> {
    const accountIds = new Set(
      [...this.accounts.values()]
        .filter((account) => this.connections.get(account.connectionId)?.userId === userId)
        .map((account) => account.id),
    );

    let stamped = 0;
    for (const link of links) {
      for (const row of this.transactionsByExternalId.values()) {
        if (!accountIds.has(row.accountId)) continue;
        if (row.subscriptionId !== null) continue;
        if (row.normalizedKey !== link.normalizedKey || row.currency !== link.currency) continue;
        row.subscriptionId = link.subscriptionId;
        stamped += 1;
      }
    }
    return Promise.resolve(stamped);
  }

  // ── WebhookStore ─────────────────────────────────────────────────────────────────────

  recordDelivery(delivery: WebhookDelivery): Promise<RecordOutcome> {
    const key = `${delivery.provider}|${delivery.externalId}`;
    if (this.deliveries.has(key)) return Promise.resolve('duplicate');
    this.deliveries.set(key, { ...delivery, processedAt: null });
    return Promise.resolve('recorded');
  }

  markProcessed(provider: string, externalId: string, at: Date): Promise<void> {
    const existing = this.deliveries.get(`${provider}|${externalId}`);
    if (existing !== undefined) this.deliveries.set(`${provider}|${externalId}`, { ...existing, processedAt: at });
    return Promise.resolve();
  }

  findConnectionByItem(
    provider: string,
    externalItemId: string,
  ): Promise<{ id: string; userId: string } | null> {
    for (const connection of this.connections.values()) {
      if (connection.provider === provider && connection.externalItemId === externalItemId) {
        return Promise.resolve({ id: connection.id, userId: connection.userId });
      }
    }
    return Promise.resolve(null);
  }

  // ── inspection, for tests and the demo seeder ────────────────────────────────────────

  transactionCount(): number {
    return this.transactionsByExternalId.size;
  }

  listTransactions(): readonly MemoryTransaction[] {
    return [...this.transactionsByExternalId.values()];
  }

  detectionStatus(userId: string, normalizedKey: string, currencyCode: string): DetectionStatus | null {
    return this.detections.get(`${userId}|${normalizedKey}|${currencyCode}`)?.status ?? null;
  }

  setDetectionStatus(
    userId: string,
    normalizedKey: string,
    currencyCode: string,
    status: DetectionStatus,
    subscriptionId: string | null = null,
  ): void {
    const row = this.detections.get(`${userId}|${normalizedKey}|${currencyCode}`);
    if (row === undefined) throw new Error(`No detection for ${normalizedKey}/${currencyCode}`);
    row.status = status;
    row.subscriptionId = subscriptionId;
  }

  /**
   * Rewinds (or fast-forwards) a connection's cursor.
   *
   * The idempotency test needs this: replaying the *whole* feed from `null` is the only version
   * of "run it twice" that actually exercises the unique indexes. Re-running from the persisted
   * cursor just fetches an empty page and proves nothing.
   */
  setCursor(connectionId: string, cursor: string | null): void {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) throw new Error(`Unknown connection ${connectionId}`);
    connection.cursor = cursor;
  }

  connection(connectionId: string): StoredConnection | null {
    const connection = this.connections.get(connectionId);
    return connection === undefined ? null : snapshot(connection);
  }

  connectionError(connectionId: string): ConnectionFailure | null {
    return this.connections.get(connectionId)?.error ?? null;
  }

  deliveryCount(): number {
    return this.deliveries.size;
  }

  private mint(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${String(this.sequence).padStart(6, '0')}`;
  }
}

function snapshot(connection: MutableConnection): StoredConnection {
  return {
    id: connection.id,
    userId: connection.userId,
    provider: connection.provider,
    externalItemId: connection.externalItemId,
    accessTokenCiphertext: connection.accessTokenCiphertext,
    keyId: connection.keyId,
    cursor: connection.cursor,
    status: connection.status,
    consentExpiresAt: connection.consentExpiresAt,
    backfillCompletedAt: connection.backfillCompletedAt,
  };
}
