/**
 * The sync engine.
 *
 * Four properties, and every design decision in this file is downstream of one of them.
 *
 * **Idempotent.** Running a sync twice inserts zero duplicate transactions. That is enforced by
 * two unique indexes and an `ON CONFLICT DO NOTHING`, never by reading first and then deciding —
 * a read-then-write is a race, and the race is won by the retry that runs while the first attempt
 * is still in flight. `external_id` catches re-delivery of the same row; `(account_id,
 * dedupe_hash)` catches the harder case, where an aggregator re-issues a pending charge under a
 * new id once it posts.
 *
 * **Resumable.** The cursor is written in the *same transaction* as the page it describes. Kill
 * the worker between page 3 and page 4 and the connection's cursor still points at the end of
 * page 3, so the restart re-requests page 4 and nothing is lost. Kill it mid-page and the
 * transaction rolls back both the rows and the cursor together, so the restart replays page 3
 * against `ON CONFLICT DO NOTHING` and nothing is duplicated. Committing rows and cursor
 * separately is the bug this ordering exists to make impossible.
 *
 * **Answered questions stay answered.** Reconciliation never moves a detection out of
 * `confirmed` or `dismissed`. A sync that reset a dismissed detection to `pending` would re-ask
 * a question the user already answered, every time the merchant charged them again. The
 * mechanism is structural rather than conditional: `DetectionWrite` has no `status` field, and
 * the upsert never lists that column in its update set.
 *
 * **No Postgres required to test any of it.** The decisions live in pure functions —
 * `planPage`, `planDetections`, `planSubscriptionLinks` — and the SQL lives behind `SyncStore`,
 * which is a parameter. `store.ts` implements it over Drizzle; `memory-store.ts` implements it
 * over Maps, honouring the same two unique constraints. The acceptance tests run against the
 * second one and are testing the same logic the first one runs.
 */

import { createHash } from 'node:crypto';
import {
  type BillingChannel,
  type Clock,
  type ConnectionStatus,
  type DetectionStatus,
  type IntervalUnit,
  formatPlainDate,
  fromInstant,
  isUuid,
  toInstant,
  today as todayIn,
} from '@ledger/core';
import {
  type DetectionOptions,
  type DetectionTransaction,
  type MerchantRegistry,
  type SubscriptionCandidate,
  detectSubscriptions,
  normalizeDescriptor,
} from '@ledger/detection';
import { childLogger, type Logger } from '@ledger/logger';

import {
  type AggregatorAccount,
  type AggregatorAdapter,
  type AggregatorTransaction,
  type SyncPage,
  AggregatorError,
  isAggregatorError,
} from './adapter';

/** The backfill window on first connect. Matches `TRANSACTION_RETENTION_MONTHS`'s default. */
export const BACKFILL_MONTHS = 24;

/**
 * How many pages one run will pull before handing back to the queue.
 *
 * A bound rather than "until done" so a single connection cannot occupy a worker for an hour
 * during its initial backfill. `SyncResult.hasMore` tells the caller to re-enqueue, and the
 * cursor means the next run costs nothing to resume.
 */
export const DEFAULT_MAX_PAGES = 40;

// ── stored shapes ──────────────────────────────────────────────────────────────────────

export interface StoredConnection {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly externalItemId: string;
  readonly accessTokenCiphertext: string;
  readonly keyId: string;
  readonly cursor: string | null;
  readonly status: ConnectionStatus;
  readonly consentExpiresAt: Date | null;
  readonly backfillCompletedAt: Date | null;
}

export interface StoredAccount {
  readonly id: string;
  readonly externalId: string;
  readonly currency: string;
  /** Set when the user asked detection to ignore this account — a business current account. */
  readonly excludedFromDetection: Date | null;
}

/** One row bound for `transactions`, with every derived column already computed. */
export interface TransactionWrite {
  readonly accountId: string;
  readonly externalId: string;
  readonly postedAt: Date;
  readonly authorizedAt: Date | null;
  /** Positive = money leaving. Normalised at the adapter boundary; see `adapter.ts`. */
  readonly amountMinor: number;
  readonly currency: string;
  readonly rawDescriptor: string;
  readonly normalizedKey: string;
  readonly billingChannel: BillingChannel;
  readonly pending: boolean;
  readonly dedupeHash: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface CommitPageInput {
  readonly connectionId: string;
  readonly userId: string;
  readonly rows: readonly TransactionWrite[];
  readonly removedExternalIds: readonly string[];
  /** Written in the same transaction as `rows`. That is the resumability guarantee. */
  readonly cursor: string;
  readonly syncedAt: Date;
}

export interface CommitPageResult {
  readonly inserted: number;
  /** Rows that already existed under the same external id and were refreshed. */
  readonly updated: number;
  /** Pending rows resolved into posted by a re-issue that collided on `dedupe_hash`. */
  readonly settled: number;
  readonly removed: number;
}

export interface ConnectionFailure {
  readonly code: string;
  readonly message: string;
  readonly at: string;
  readonly retryable: boolean;
}

export interface FinishSyncInput {
  readonly connectionId: string;
  readonly syncedAt: Date;
  /** Only sent on the run that completes the initial backfill. */
  readonly backfillCompletedAt: Date | null;
}

export interface StoredDetection {
  readonly id: string;
  readonly normalizedKey: string;
  readonly currency: string;
  readonly status: DetectionStatus;
  readonly subscriptionId: string | null;
}

/**
 * A detection row as sync writes it.
 *
 * There is deliberately no `status`. Sync proposes evidence; only the user resolves a detection,
 * and the absence of the field is what makes "a later sync cannot un-answer a question" a
 * property of the type rather than of a conditional somebody could delete.
 */
export interface DetectionWrite {
  readonly normalizedKey: string;
  readonly currency: string;
  readonly billingChannel: BillingChannel;
  readonly intervalUnit: IntervalUnit;
  readonly intervalCount: number;
  readonly medianAmountMinor: number;
  /** Numeric column — a string, so no float ever round-trips through the database. */
  readonly amountCv: string;
  readonly occurrences: number;
  /** `YYYY-MM-DD`; these are `date` columns, not instants. */
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly nextExpectedAt: string | null;
  readonly confidence: string;
  readonly merchantId: string | null;
  readonly evidence: {
    readonly transactionIds: string[];
    readonly gapDays: number[];
    readonly matchedVia: 'exact' | 'alias' | 'trigram' | 'none';
    readonly matchScore: number;
    readonly confidenceFactors: Record<string, number>;
    readonly sampleDescriptors: string[];
  };
}

export interface DetectionWriteResult {
  readonly inserted: number;
  readonly updated: number;
}

export interface SubscriptionLink {
  readonly normalizedKey: string;
  readonly currency: string;
  readonly subscriptionId: string;
}

/**
 * Everything the engine needs from the database, and nothing else.
 *
 * Narrow on purpose. Each method is one statement or one transaction, which is what "keep the
 * SQL thin" means in practice: if a method here needs a paragraph of logic, that logic belongs
 * in one of the pure planners above it.
 */
export interface SyncStore {
  loadConnection(userId: string, connectionId: string): Promise<StoredConnection | null>;
  upsertAccounts(
    connectionId: string,
    accounts: readonly AggregatorAccount[],
  ): Promise<ReadonlyMap<string, StoredAccount>>;
  /** Rows, retractions, and the cursor. One transaction. */
  commitPage(input: CommitPageInput): Promise<CommitPageResult>;
  finishSync(input: FinishSyncInput): Promise<void>;
  recordFailure(connectionId: string, failure: ConnectionFailure): Promise<void>;
  clearFailure(connectionId: string): Promise<void>;
  /** Every transaction the detector should see, in the shape it wants. */
  loadDetectionInput(userId: string): Promise<readonly DetectionTransaction[]>;
  listDetections(userId: string): Promise<readonly StoredDetection[]>;
  writeDetections(userId: string, writes: readonly DetectionWrite[]): Promise<DetectionWriteResult>;
  linkSubscriptions(userId: string, links: readonly SubscriptionLink[]): Promise<number>;
}

// ── pure: one page into rows ───────────────────────────────────────────────────────────

export interface PagePlan {
  readonly rows: readonly TransactionWrite[];
  readonly removedExternalIds: readonly string[];
  /** Rows for accounts we do not hold — the user deselected one, or it closed. Counted, not thrown. */
  readonly skippedUnknownAccount: number;
  /** Rows dropped because an earlier row in the same page already claimed their dedupe slot. */
  readonly collapsedWithinPage: number;
}

/**
 * Turns one aggregator page into the rows to write.
 *
 * The only interesting part is the within-page collapse. Postgres will happily accept two rows
 * with the same `(account_id, dedupe_hash)` in one `INSERT … ON CONFLICT DO NOTHING` and keep
 * whichever it inserted first — which, when a pending charge and its posted re-issue arrive in
 * the same page, is a coin flip. Deciding it here instead means the posted row always wins, and
 * means the outcome does not depend on the order the aggregator happened to serialise them in.
 */
export function planPage(
  page: Pick<SyncPage, 'added' | 'modified' | 'removed'>,
  accounts: ReadonlyMap<string, StoredAccount>,
): PagePlan {
  const byExternalId = new Map<string, TransactionWrite>();
  let skippedUnknownAccount = 0;

  // `modified` after `added`: within one page a revision supersedes the original.
  for (const source of [page.added, page.modified]) {
    for (const row of source) {
      const account = accounts.get(row.accountExternalId);
      if (account === undefined) {
        skippedUnknownAccount += 1;
        continue;
      }
      byExternalId.set(row.externalId, toWrite(row, account));
    }
  }

  const byDedupe = new Map<string, TransactionWrite>();
  let collapsedWithinPage = 0;
  for (const row of byExternalId.values()) {
    const key = `${row.accountId}|${row.dedupeHash}`;
    const existing = byDedupe.get(key);
    if (existing === undefined) {
      byDedupe.set(key, row);
      continue;
    }
    collapsedWithinPage += 1;
    // A settled charge is the truth; the authorization that preceded it is a placeholder.
    if (existing.pending && !row.pending) byDedupe.set(key, row);
  }

  const rows = [...byDedupe.values()].sort(
    (a, b) => a.postedAt.getTime() - b.postedAt.getTime() || a.externalId.localeCompare(b.externalId),
  );

  return {
    rows,
    removedExternalIds: [...new Set(page.removed)],
    skippedUnknownAccount,
    collapsedWithinPage,
  };
}

function toWrite(row: AggregatorTransaction, account: StoredAccount): TransactionWrite {
  const descriptor = normalizeDescriptor(row.rawDescriptor);
  // Midnight UTC. The column is a timestamptz but the fact is a posting *date*: a bank does not
  // know what time a direct debit settled, and inventing an hour would make the same charge fall
  // on different days for users in different zones.
  const postedAt = toInstant(row.postedAt, 'UTC');

  return {
    accountId: account.id,
    externalId: row.externalId,
    postedAt,
    authorizedAt: row.authorizedAt === null ? null : toInstant(row.authorizedAt, 'UTC'),
    amountMinor: row.amountMinor,
    currency: row.currency === '' ? account.currency : row.currency,
    rawDescriptor: row.rawDescriptor,
    normalizedKey: descriptor.normalized,
    billingChannel: descriptor.channel,
    pending: row.pending,
    dedupeHash: dedupeHashFor(account.id, row.postedAt, row.amountMinor, descriptor.normalized),
    raw: row.raw,
  };
}

/**
 * `sha256(accountId | postedAt | amountMinor | normalizedKey)`, per the schema.
 *
 * The date is the *posting date*, not the instant, so the hash does not change if the timezone
 * handling around it ever does. The normalized key rather than the raw descriptor, because the
 * re-issue this is meant to catch frequently arrives with a different raw descriptor — the
 * pending form often lacks the location suffix the posted one carries.
 */
export function dedupeHashFor(
  accountId: string,
  postedAt: { year: number; month: number; day: number },
  amountMinor: number,
  normalizedKey: string,
): string {
  return createHash('sha256')
    .update(
      `${accountId}|${formatPlainDate(postedAt)}|${String(amountMinor)}|${normalizedKey}`,
      'utf8',
    )
    .digest('hex');
}

// ── pure: candidates into detection rows ───────────────────────────────────────────────

/** `detections_user_key_unique` is on (user_id, normalized_key, currency). */
export function detectionKey(normalizedKey: string, currency: string): string {
  return `${normalizedKey}|${currency}`;
}

export interface DetectionPlan {
  readonly writes: readonly DetectionWrite[];
  /** Keys with no existing row — what a "we found N new subscriptions" notification counts. */
  readonly newKeys: readonly string[];
  /** Keys the user has already answered. Their status is not in `writes` and never will be. */
  readonly preservedKeys: readonly string[];
}

/**
 * Plans the detection upsert.
 *
 * Every candidate produces a write, including ones the user has already confirmed or dismissed —
 * the *evidence* should stay current (a confirmed subscription's next expected date moves every
 * month, and a dismissed one's occurrence count is how we would notice we were wrong). What does
 * not move is the status, and the only way to move it is a deliberate user action through the
 * review queue.
 */
export function planDetections(
  candidates: readonly SubscriptionCandidate[],
  existing: readonly StoredDetection[],
): DetectionPlan {
  const known = new Map(existing.map((row) => [detectionKey(row.normalizedKey, row.currency), row]));

  const writes: DetectionWrite[] = [];
  const newKeys: string[] = [];
  const preservedKeys: string[] = [];

  for (const candidate of candidates) {
    // A cluster whose descriptor reduced to nothing has no stable key to be unique on, and two
    // unrelated merchants would collide under the empty string.
    if (candidate.normalizedKey === '') continue;

    const key = detectionKey(candidate.normalizedKey, candidate.currency);
    const prior = known.get(key);
    if (prior === undefined) newKeys.push(key);
    else if (prior.status !== 'pending') preservedKeys.push(key);

    writes.push(toDetectionWrite(candidate));
  }

  return { writes, newKeys, preservedKeys };
}

/**
 * The status a row ends up with after a sync-driven upsert.
 *
 * One function so `store.ts` and `memory-store.ts` cannot drift, and so the rule has somewhere
 * to be tested. `null` means the row is new.
 */
export function preservedDetectionStatus(existing: DetectionStatus | null): DetectionStatus {
  return existing ?? 'pending';
}

function toDetectionWrite(candidate: SubscriptionCandidate): DetectionWrite {
  return {
    normalizedKey: candidate.normalizedKey,
    currency: candidate.currency,
    billingChannel: candidate.channel,
    intervalUnit: candidate.interval.unit,
    intervalCount: candidate.interval.count,
    medianAmountMinor: candidate.medianAmountMinor,
    // `numeric` columns are strings end to end. The detector's confidence and CV are ratios, not
    // money, but they still must not be handed to Postgres as doubles and rounded twice.
    amountCv: candidate.amountCv.toFixed(4),
    occurrences: candidate.occurrences,
    firstSeen: formatPlainDate(candidate.firstSeen),
    lastSeen: formatPlainDate(candidate.lastSeen),
    nextExpectedAt:
      candidate.nextExpectedAt === null ? null : formatPlainDate(candidate.nextExpectedAt),
    confidence: candidate.confidence.toFixed(3),
    // The registry's merchant id is a slug from the YAML dataset; `detections.merchant_id` is a
    // foreign key to `merchants.id`. Writing the slug would violate the constraint, so it is
    // dropped unless the registry is already serving database ids. Resolving slug → row is the
    // integration step that belongs with whoever loads the dataset, not here.
    merchantId:
      candidate.merchantMatch.merchantId !== null && isUuid(candidate.merchantMatch.merchantId)
        ? candidate.merchantMatch.merchantId
        : null,
    evidence: {
      transactionIds: [...candidate.transactionIds],
      gapDays: [...candidate.gapDays],
      matchedVia: candidate.merchantMatch.matchedVia,
      matchScore: candidate.merchantMatch.score,
      confidenceFactors: { ...candidate.confidenceFactors },
      sampleDescriptors: [...candidate.sampleDescriptors],
    },
  };
}

/**
 * Which transactions should carry a subscription id.
 *
 * Only detections the user confirmed, and only once they have a subscription to point at. A
 * pending detection stamping rows would be the engine asserting something the user has not
 * agreed to yet.
 */
export function planSubscriptionLinks(
  detections: readonly StoredDetection[],
): readonly SubscriptionLink[] {
  const links: SubscriptionLink[] = [];
  for (const detection of detections) {
    if (detection.status !== 'confirmed' || detection.subscriptionId === null) continue;
    links.push({
      normalizedKey: detection.normalizedKey,
      currency: detection.currency,
      subscriptionId: detection.subscriptionId,
    });
  }
  return links;
}

// ── the engine ─────────────────────────────────────────────────────────────────────────

export interface SyncContext {
  readonly adapter: AggregatorAdapter;
  readonly store: SyncStore;
  readonly clock: Clock;
  /** Improves merchant matching when present. Detection works without it. */
  readonly registry?: MerchantRegistry;
  readonly logger?: Logger;
}

export interface SyncTarget {
  readonly userId: string;
  readonly connectionId: string;
}

export interface SyncOptions {
  readonly maxPages?: number;
  /** Off for a pure "pull the pages" run — the reconcile is re-run by the worker afterwards. */
  readonly reconcile?: boolean;
}

export interface SyncResult {
  readonly connectionId: string;
  readonly pages: number;
  readonly inserted: number;
  readonly updated: number;
  readonly settled: number;
  readonly removed: number;
  readonly skippedUnknownAccount: number;
  readonly cursor: string | null;
  /** True when the page budget ran out before the aggregator did. Re-enqueue. */
  readonly hasMore: boolean;
  readonly backfillCompleted: boolean;
  readonly detections: DetectionSummary | null;
}

export interface DetectionSummary {
  readonly candidates: number;
  readonly inserted: number;
  readonly updated: number;
  readonly newKeys: number;
  readonly preservedKeys: number;
  readonly linkedTransactions: number;
}

/**
 * Pulls every available page for one connection, then reconciles.
 *
 * The loop reads its cursor from the page it just committed rather than from a local counter, so
 * there is no state in this function that could survive a crash and be wrong afterwards. On
 * failure the error is recorded against the connection — that row is what `health.ts` reads and
 * what the UI shows — and then rethrown, because a sync that swallows its own failure is a
 * connection that silently stops updating.
 */
export async function syncConnection(
  context: SyncContext,
  target: SyncTarget,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const log = context.logger ?? childLogger('banking.sync');
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  const connection = await context.store.loadConnection(target.userId, target.connectionId);
  if (connection === null) {
    throw new AggregatorError(
      context.adapter.provider,
      'item_not_found',
      'That bank connection does not exist, or it is not yours.',
      { connectionId: target.connectionId },
    );
  }

  try {
    const accounts = await context.store.upsertAccounts(
      connection.id,
      await context.adapter.getAccounts(connection),
    );

    let cursor = connection.cursor;
    let pages = 0;
    let inserted = 0;
    let updated = 0;
    let settled = 0;
    let removed = 0;
    let skippedUnknownAccount = 0;
    let hasMore = true;

    while (hasMore && pages < maxPages) {
      const page = await context.adapter.syncTransactions(connection, cursor);
      const plan = planPage(page, accounts);

      const committed = await context.store.commitPage({
        connectionId: connection.id,
        userId: connection.userId,
        rows: plan.rows,
        removedExternalIds: plan.removedExternalIds,
        cursor: page.nextCursor,
        syncedAt: context.clock.now(),
      });

      // Only after `commitPage` resolves — which is only after the transaction holding both the
      // rows and the cursor committed — does the loop advance.
      cursor = page.nextCursor;
      pages += 1;
      inserted += committed.inserted;
      updated += committed.updated;
      settled += committed.settled;
      removed += committed.removed;
      skippedUnknownAccount += plan.skippedUnknownAccount;
      hasMore = page.hasMore;
    }

    const completedBackfill = !hasMore && connection.backfillCompletedAt === null;
    const now = context.clock.now();
    await context.store.finishSync({
      connectionId: connection.id,
      syncedAt: now,
      backfillCompletedAt: completedBackfill ? now : null,
    });
    await context.store.clearFailure(connection.id);

    const detections =
      options.reconcile === false ? null : await reconcileDetections(context, connection.userId);

    log.info(
      {
        connectionId: connection.id,
        pages,
        inserted,
        updated,
        settled,
        removed,
        hasMore,
        backfillCompleted: completedBackfill,
      },
      'sync complete',
    );

    return {
      connectionId: connection.id,
      pages,
      inserted,
      updated,
      settled,
      removed,
      skippedUnknownAccount,
      cursor,
      hasMore,
      backfillCompleted: completedBackfill,
      detections,
    };
  } catch (cause) {
    const failure = toFailure(cause, context.clock);
    // Recorded before the rethrow so the connection's health is correct even if the queue drops
    // the job entirely. Note that only the sanitised code and message are stored — an aggregator
    // error object carries the request that produced it, and that request carries a token.
    await context.store.recordFailure(connection.id, failure);
    log.error(
      { connectionId: connection.id, code: failure.code, retryable: failure.retryable },
      failure.message,
    );
    throw cause;
  }
}

/**
 * Re-runs detection over everything the user has and folds the result into `detections`.
 *
 * Whole-history rather than incremental because detection is a clustering problem: one new
 * charge can turn a two-occurrence "not enough evidence" into a confirmed annual subscription,
 * and there is no way to know that from the new row alone. The engine is pure and fast enough
 * that this is the right trade at the scale this product targets.
 */
export async function reconcileDetections(
  context: SyncContext,
  userId: string,
): Promise<DetectionSummary> {
  const transactions = await context.store.loadDetectionInput(userId);

  const detectionOptions: DetectionOptions =
    context.registry === undefined
      ? { today: todayIn(context.clock, 'UTC') }
      : { today: todayIn(context.clock, 'UTC'), registry: context.registry };

  const result = detectSubscriptions(transactions, detectionOptions);

  const existing = await context.store.listDetections(userId);
  const plan = planDetections(result.candidates, existing);
  const written = await context.store.writeDetections(userId, plan.writes);

  // Read back rather than reusing `existing`: a detection confirmed between the two calls should
  // get its transactions stamped on this run rather than waiting for the next one.
  const linked = await context.store.linkSubscriptions(
    userId,
    planSubscriptionLinks(await context.store.listDetections(userId)),
  );

  return {
    candidates: result.candidates.length,
    inserted: written.inserted,
    updated: written.updated,
    newKeys: plan.newKeys.length,
    preservedKeys: plan.preservedKeys.length,
    linkedTransactions: linked,
  };
}

function toFailure(cause: unknown, clock: Clock): ConnectionFailure {
  const at = clock.now().toISOString();
  if (isAggregatorError(cause)) {
    return { code: cause.aggregatorCode, message: cause.message, at, retryable: cause.retryable };
  }
  if (cause instanceof Error) {
    // Deliberately only the message. Attaching the object risks serialising an upstream
    // request, and an upstream request is where the access token lives.
    return { code: 'upstream', message: cause.message, at, retryable: true };
  }
  return { code: 'upstream', message: 'Sync failed for an unknown reason.', at, retryable: true };
}

// ── detection input helper ─────────────────────────────────────────────────────────────

/**
 * A stored transaction row in the shape `@ledger/detection` wants.
 *
 * Lives here rather than in the store so both implementations produce identical input — the
 * `PlainDate` conversion in particular is the kind of thing two implementations would get
 * subtly different, and detection is sensitive to a one-day shift.
 */
export function toDetectionTransaction(row: {
  id: string;
  postedAt: Date;
  amountMinor: number;
  currency: string;
  rawDescriptor: string;
  accountId: string;
  pending: boolean;
}): DetectionTransaction {
  return {
    id: row.id,
    postedAt: fromInstant(row.postedAt, 'UTC'),
    amountMinor: row.amountMinor,
    currency: row.currency,
    rawDescriptor: row.rawDescriptor,
    accountId: row.accountId,
    pending: row.pending,
  };
}
