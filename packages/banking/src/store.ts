/**
 * The Postgres `SyncStore` and `WebhookStore`.
 *
 * Deliberately dull. Every decision worth arguing about lives in `sync.ts` as a pure function;
 * what is left here is the smallest set of statements that can express those decisions, which is
 * the only way the engine's behaviour stays testable without a database.
 *
 * Two things are not dull and are worth the paragraph:
 *
 * **`commitPage` is one transaction, and the cursor is inside it.** Rows, retractions, and
 * `bank_connections.cursor` commit together or not at all. That is the entire resumability
 * story: there is no window in which the cursor claims a page landed that did not.
 *
 * **The transaction insert has no conflict target.** `ON CONFLICT DO NOTHING` with a target only
 * covers that one index — a row that survives the `external_id` check and then violates
 * `(account_id, dedupe_hash)` would raise and abort the whole page. Bare `DO NOTHING` covers
 * every unique index on the table, which is what "running it twice inserts zero duplicates"
 * actually requires. The rows it skipped are then reconciled individually, which is a handful of
 * statements on a normal page and zero on a clean one.
 *
 * Every user-scoped read and write goes through `Scope`. There is not a single hand-rolled
 * `eq(table.userId, …)` in this file, per brief §5.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  type Database,
  Scope,
  bankAccounts,
  bankConnections,
  detections,
  transactions,
  webhookDeliveries,
} from '@ledger/db';
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
  toDetectionTransaction,
} from './sync';
import type { RecordOutcome, WebhookDelivery, WebhookStore } from './webhooks';

export class DrizzleSyncStore implements SyncStore, WebhookStore {
  constructor(private readonly db: Database) {}

  async loadConnection(userId: string, connectionId: string): Promise<StoredConnection | null> {
    const scope = new Scope(this.db, userId);
    const rows = await this.db
      .select({
        id: bankConnections.id,
        userId: bankConnections.userId,
        provider: bankConnections.provider,
        externalItemId: bankConnections.externalItemId,
        accessTokenCiphertext: bankConnections.accessTokenCiphertext,
        keyId: bankConnections.keyId,
        cursor: bankConnections.cursor,
        status: bankConnections.status,
        consentExpiresAt: bankConnections.consentExpiresAt,
        backfillCompletedAt: bankConnections.backfillCompletedAt,
      })
      .from(bankConnections)
      .where(scope.whereId(bankConnections, connectionId))
      .limit(1);

    return rows[0] ?? null;
  }

  async upsertAccounts(
    connectionId: string,
    accounts: readonly AggregatorAccount[],
  ): Promise<ReadonlyMap<string, StoredAccount>> {
    if (accounts.length === 0) return new Map();

    const rows = await this.db
      .insert(bankAccounts)
      .values(
        accounts.map((account) => ({
          connectionId,
          externalId: account.externalId,
          name: account.name,
          officialName: account.officialName,
          mask: account.mask,
          type: account.type,
          subtype: account.subtype,
          currency: account.currency,
        })),
      )
      .onConflictDoUpdate({
        target: [bankAccounts.connectionId, bankAccounts.externalId],
        set: {
          name: sql`excluded.name`,
          officialName: sql`excluded.official_name`,
          mask: sql`excluded.mask`,
          type: sql`excluded.type`,
          subtype: sql`excluded.subtype`,
          currency: sql`excluded.currency`,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: bankAccounts.id,
        externalId: bankAccounts.externalId,
        currency: bankAccounts.currency,
        excludedFromDetection: bankAccounts.excludedFromDetection,
      });

    return new Map(rows.map((row) => [row.externalId, row]));
  }

  async commitPage(input: CommitPageInput): Promise<CommitPageResult> {
    return this.db.transaction(async (tx) => {
      let inserted = 0;
      let updated = 0;
      let settled = 0;
      let removed = 0;

      if (input.rows.length > 0) {
        const written = await tx
          .insert(transactions)
          .values([...input.rows])
          .onConflictDoNothing()
          .returning({ externalId: transactions.externalId });

        inserted = written.length;

        const landed = new Set(written.map((row) => row.externalId));
        for (const row of input.rows) {
          if (landed.has(row.externalId)) continue;

          // Either the external id already existed (a redelivery or a revision) or the dedupe
          // fingerprint did (a pending charge re-issued as posted). Try the first, fall back to
          // the second — `external_id` is the more specific claim, so it wins.
          const refreshed = await tx
            .update(transactions)
            .set({
              postedAt: row.postedAt,
              authorizedAt: row.authorizedAt,
              amountMinor: row.amountMinor,
              currency: row.currency,
              rawDescriptor: row.rawDescriptor,
              normalizedKey: row.normalizedKey,
              billingChannel: row.billingChannel,
              pending: row.pending,
              raw: row.raw,
            })
            .where(eq(transactions.externalId, row.externalId))
            .returning({ id: transactions.id });

          if (refreshed.length > 0) {
            updated += 1;
            continue;
          }

          if (row.pending) continue;
          const resolved = await tx
            .update(transactions)
            .set({ pending: false, authorizedAt: row.authorizedAt })
            .where(
              and(
                eq(transactions.accountId, row.accountId),
                eq(transactions.dedupeHash, row.dedupeHash),
                eq(transactions.pending, true),
              ),
            )
            .returning({ id: transactions.id });
          settled += resolved.length;
        }
      }

      if (input.removedExternalIds.length > 0) {
        const dropped = await tx
          .delete(transactions)
          .where(
            and(
              inArray(transactions.externalId, [...input.removedExternalIds]),
              // Constrained to this connection's accounts: a retraction naming someone else's
              // external id must not be able to delete their row.
              inArray(
                transactions.accountId,
                tx
                  .select({ id: bankAccounts.id })
                  .from(bankAccounts)
                  .where(eq(bankAccounts.connectionId, input.connectionId)),
              ),
            ),
          )
          .returning({ id: transactions.id });
        removed = dropped.length;
      }

      // Same transaction as the rows above. This line is the resumability guarantee.
      const scope = new Scope(tx, input.userId);
      await tx
        .update(bankConnections)
        .set({ cursor: input.cursor, lastSyncedAt: input.syncedAt, updatedAt: input.syncedAt })
        .where(scope.whereId(bankConnections, input.connectionId));

      return { inserted, updated, settled, removed };
    });
  }

  async finishSync(input: FinishSyncInput): Promise<void> {
    const values =
      input.backfillCompletedAt === null
        ? { lastSyncedAt: input.syncedAt, updatedAt: input.syncedAt }
        : {
            lastSyncedAt: input.syncedAt,
            backfillCompletedAt: input.backfillCompletedAt,
            updatedAt: input.syncedAt,
          };

    await this.db
      .update(bankConnections)
      .set(values)
      .where(eq(bankConnections.id, input.connectionId));
  }

  async recordFailure(connectionId: string, failure: ConnectionFailure): Promise<void> {
    await this.db
      .update(bankConnections)
      .set({ error: failure, updatedAt: new Date(failure.at) })
      .where(eq(bankConnections.id, connectionId));
  }

  async clearFailure(connectionId: string): Promise<void> {
    await this.db
      .update(bankConnections)
      .set({ error: null })
      .where(eq(bankConnections.id, connectionId));
  }

  async loadDetectionInput(userId: string): Promise<readonly DetectionTransaction[]> {
    const scope = new Scope(this.db, userId);
    const rows = await this.db
      .select({
        id: transactions.id,
        postedAt: transactions.postedAt,
        amountMinor: transactions.amountMinor,
        currency: transactions.currency,
        rawDescriptor: transactions.rawDescriptor,
        accountId: transactions.accountId,
        pending: transactions.pending,
      })
      .from(transactions)
      .innerJoin(bankAccounts, eq(transactions.accountId, bankAccounts.id))
      // An account the user excluded still syncs — they may want the spend in their totals — but
      // it must not manufacture subscriptions. That is what the column is for.
      .where(scope.transactions(isNull(bankAccounts.excludedFromDetection)));

    return rows.map((row) => toDetectionTransaction(row));
  }

  async listDetections(userId: string): Promise<readonly StoredDetection[]> {
    const scope = new Scope(this.db, userId);
    return this.db
      .select({
        id: detections.id,
        normalizedKey: detections.normalizedKey,
        currency: detections.currency,
        status: detections.status,
        subscriptionId: detections.subscriptionId,
      })
      .from(detections)
      .where(scope.where(detections));
  }

  async writeDetections(
    userId: string,
    writes: readonly DetectionWrite[],
  ): Promise<DetectionWriteResult> {
    if (writes.length === 0) return { inserted: 0, updated: 0 };

    const scope = new Scope(this.db, userId);

    // Read the keys first purely to report insert/update counts honestly — the upsert below is
    // what actually decides, and it does not depend on this having been accurate.
    const existing = await this.db
      .select({ normalizedKey: detections.normalizedKey, currency: detections.currency })
      .from(detections)
      .where(
        scope.where(
          detections,
          inArray(detections.normalizedKey, writes.map((write) => write.normalizedKey)),
        ),
      );
    const known = new Set(existing.map((row) => `${row.normalizedKey}|${row.currency}`));

    await this.db
      .insert(detections)
      .values(
        scope.ownAll(
          writes.map((write) => ({
            normalizedKey: write.normalizedKey,
            currency: write.currency,
            billingChannel: write.billingChannel,
            intervalUnit: write.intervalUnit,
            intervalCount: write.intervalCount,
            medianAmountMinor: write.medianAmountMinor,
            amountCv: write.amountCv,
            occurrences: write.occurrences,
            firstSeen: write.firstSeen,
            lastSeen: write.lastSeen,
            nextExpectedAt: write.nextExpectedAt,
            confidence: write.confidence,
            merchantId: write.merchantId,
            evidence: write.evidence,
          })),
        ),
      )
      .onConflictDoUpdate({
        target: [detections.userId, detections.normalizedKey, detections.currency],
        // `status` is absent, and that absence is the feature: a detection the user confirmed or
        // dismissed keeps its answer no matter how many times the merchant charges them again.
        // See `planDetections` in sync.ts.
        set: {
          billingChannel: sql`excluded.billing_channel`,
          intervalUnit: sql`excluded.interval_unit`,
          intervalCount: sql`excluded.interval_count`,
          medianAmountMinor: sql`excluded.median_amount_minor`,
          amountCv: sql`excluded.amount_cv`,
          occurrences: sql`excluded.occurrences`,
          firstSeen: sql`excluded.first_seen`,
          lastSeen: sql`excluded.last_seen`,
          nextExpectedAt: sql`excluded.next_expected_at`,
          confidence: sql`excluded.confidence`,
          merchantId: sql`excluded.merchant_id`,
          evidence: sql`excluded.evidence`,
          updatedAt: sql`now()`,
        },
      });

    let inserted = 0;
    for (const write of writes) {
      if (!known.has(`${write.normalizedKey}|${write.currency}`)) inserted += 1;
    }
    return { inserted, updated: writes.length - inserted };
  }

  async linkSubscriptions(userId: string, links: readonly SubscriptionLink[]): Promise<number> {
    const scope = new Scope(this.db, userId);
    let stamped = 0;

    for (const link of links) {
      const rows = await this.db
        .update(transactions)
        .set({ subscriptionId: link.subscriptionId })
        .where(
          scope.transactions(
            eq(transactions.normalizedKey, link.normalizedKey),
            eq(transactions.currency, link.currency),
            // Only unstamped rows: a charge already attributed to another subscription is
            // evidence of a duplicate, not something to silently reassign.
            isNull(transactions.subscriptionId),
          ),
        )
        .returning({ id: transactions.id });
      stamped += rows.length;
    }

    return stamped;
  }

  // ── WebhookStore ─────────────────────────────────────────────────────────────────────

  async recordDelivery(delivery: WebhookDelivery): Promise<RecordOutcome> {
    const rows = await this.db
      .insert(webhookDeliveries)
      .values({
        provider: delivery.provider,
        externalId: delivery.externalId,
        itemId: delivery.itemId,
        type: delivery.type,
        payload: delivery.payload,
        receivedAt: delivery.receivedAt,
      })
      .onConflictDoNothing({
        target: [webhookDeliveries.provider, webhookDeliveries.externalId],
      })
      .returning({ id: webhookDeliveries.id });

    // Zero rows back means the unique index rejected it, which means we have already handled
    // this delivery. That is the replay guard, and it is one statement wide on purpose.
    return rows.length === 0 ? 'duplicate' : 'recorded';
  }

  async markProcessed(provider: string, externalId: string, at: Date): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({ processedAt: at })
      .where(
        and(eq(webhookDeliveries.provider, provider), eq(webhookDeliveries.externalId, externalId)),
      );
  }

  async findConnectionByItem(
    provider: string,
    externalItemId: string,
  ): Promise<{ id: string; userId: string } | null> {
    // Not scoped, and cannot be: this lookup is what *establishes* which user a webhook belongs
    // to. The aggregator's item id is the only identity an inbound delivery carries.
    const rows = await this.db
      .select({ id: bankConnections.id, userId: bankConnections.userId })
      .from(bankConnections)
      .where(
        and(
          eq(bankConnections.provider, provider),
          eq(bankConnections.externalItemId, externalItemId),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }
}
