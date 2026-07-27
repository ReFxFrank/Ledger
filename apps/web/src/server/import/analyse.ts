import 'server-only';

import { createHash } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import {
  type DetectionWrite,
  type StoredDetection,
  detectionKey,
  planDetections,
} from '@ledger/banking';
import {
  type Clock,
  type IntervalUnit,
  type PlainDate,
  formatPlainDate,
  isCurrencyCode,
  parsePlainDate,
  today as todayIn,
} from '@ledger/core';
import { type Database, type Scope, detections } from '@ledger/db';
import {
  type DetectionOptions,
  type DetectionTransaction,
  type SubscriptionCandidate,
  detectSubscriptions,
} from '@ledger/detection';
import { childLogger } from '@ledger/logger';

import { getMerchantRegistry } from '~/server/banking/runtime';

/**
 * CSV import, run through the detection engine.
 *
 * A bank export is not a list of subscriptions. It is a list of everything that moved, and twelve
 * months of a Chase current account is roughly one recurring charge for every forty rows of Uber
 * Eats, Zelle and one-off retail. The direct row-to-subscription importer is the right tool for a
 * hand-written list and the wrong tool for this: pointed at a bank export it offers to create one
 * subscription per transaction, which is not a subscription tracker, it is a transaction copier.
 *
 * So this path does what the bank path does. `detectSubscriptions` clusters the rows, infers a
 * cadence, and scores its own confidence; `planDetections` folds the survivors into `detections`
 * with the same status-preservation rule the sync engine uses. The registry comes from
 * `getMerchantRegistry`, which reads the `merchants` **table** — the same loader `runConnectionSync`
 * uses, because `detections.merchant_id` is a foreign key and a registry keyed on anything else
 * writes rows that cannot be inserted.
 *
 * Two things are genuinely different from the bank path, and both are here rather than hidden:
 *
 *  1. **The sign is inferred, not assumed.** An aggregator states its convention; a CSV does not.
 *     See `inferSignConvention` — and note the summary reports which way it decided, because
 *     guessing silently is how `Zelle payment from JOSEPHINE BARBARA` became a $40/month
 *     subscription.
 *  2. **The transactions are not in the database.** These rows were parsed in the browser and
 *     never stored, so the ids in the evidence blob are synthesised. `syntheticTransactionId`
 *     explains why they are still UUID-shaped.
 */

const log = childLogger('web.import');

/** One parsed row, in whatever sign convention the file was written with. */
export interface ImportedRow {
  readonly descriptor: string;
  /** Integer minor units, sign exactly as the file wrote it. */
  readonly amountMinor: number;
  /** `YYYY-MM-DD`, already resolved by the client's date-order control. */
  readonly postedAt: string;
  readonly currency?: string | undefined;
}

// ── sign inference ─────────────────────────────────────────────────────────────────────

/**
 * Which way the file writes money leaving the account.
 *
 * `debits_negative` is Chase and most US bank exports (`-16.32` is a purchase). `debits_positive`
 * is what a hand-written list and several European exports do.
 */
export type SignConvention = 'debits_negative' | 'debits_positive';

export interface SignInference {
  readonly convention: SignConvention;
  readonly negativeRows: number;
  readonly positiveRows: number;
}

/**
 * Decides the convention from the majority sign in the file.
 *
 * A current account spends more often than it receives — twelve months of a Chase export is a few
 * hundred debits against a dozen paycheques — so the majority sign is the debit sign, and that
 * holds for both conventions. It is a heuristic, which is why the caller reports it: the failure
 * mode of getting this wrong is not an error, it is a review queue full of the user's salary.
 *
 * A tie resolves to `debits_positive`, the convention that needs no reinterpretation. A file with
 * as many credits as debits is not a bank export, and taking it at face value is the smaller lie.
 */
export function inferSignConvention(rows: readonly ImportedRow[]): SignInference {
  let negativeRows = 0;
  let positiveRows = 0;
  for (const row of rows) {
    if (row.amountMinor < 0) negativeRows += 1;
    else if (row.amountMinor > 0) positiveRows += 1;
  }
  return {
    convention: negativeRows > positiveRows ? 'debits_negative' : 'debits_positive',
    negativeRows,
    positiveRows,
  };
}

// ── rows → detection input ─────────────────────────────────────────────────────────────

/**
 * Every synthetic row claims the same account.
 *
 * Detection uses `accountId` to split a cluster that spans two cards and to spot duplicates; a
 * CSV is one export of one account, so one id is the truthful answer. It is never written to
 * `bank_accounts` — nothing in this path touches that table.
 */
const IMPORT_ACCOUNT_ID = 'csv-import';

export interface DetectionInput {
  readonly transactions: readonly DetectionTransaction[];
  /** Money coming in: salary, a Zelle receipt, a refund. Not subscriptions, so not analysed. */
  readonly droppedInflow: number;
  /** No descriptor, no readable date, or a zero amount. Counted rather than silently skipped. */
  readonly droppedUnreadable: number;
}

export interface DetectionInputOptions {
  readonly convention: SignConvention;
  /** Used when the row carries no currency, or one we do not recognise. */
  readonly fallbackCurrency: string;
  /** Mixed into the synthetic ids so two users importing the same file do not share them. */
  readonly seed: string;
}

/**
 * Normalises the file's rows into the one convention detection understands.
 *
 * `DetectionTransaction.amountMinor` is positive when money leaves. Inflows are dropped outright
 * rather than passed through as negatives: in a bank feed a negative row is a refund, and the
 * reversal pass pairs it with the charge it undoes — but in a CSV a positive row is far more often
 * a paycheque than a refund, and feeding those in would have the engine hunting for the cadence of
 * someone's salary. Losing genuine refund pairing is the cost, and it is the cheaper mistake.
 */
export function toDetectionInput(
  rows: readonly ImportedRow[],
  options: DetectionInputOptions,
): DetectionInput {
  const transactions: DetectionTransaction[] = [];
  let droppedInflow = 0;
  let droppedUnreadable = 0;

  rows.forEach((row, index) => {
    const rawDescriptor = row.descriptor.trim();
    if (rawDescriptor === '') {
      droppedUnreadable += 1;
      return;
    }

    let postedAt: PlainDate;
    try {
      postedAt = parsePlainDate(row.postedAt);
    } catch {
      droppedUnreadable += 1;
      return;
    }

    const outflowMinor =
      options.convention === 'debits_negative' ? -row.amountMinor : row.amountMinor;
    if (outflowMinor === 0) {
      droppedUnreadable += 1;
      return;
    }
    if (outflowMinor < 0) {
      droppedInflow += 1;
      return;
    }

    const declared = row.currency?.trim().toUpperCase() ?? '';
    const currency = declared !== '' && isCurrencyCode(declared) ? declared : options.fallbackCurrency;

    transactions.push({
      id: syntheticTransactionId(options.seed, index, row),
      postedAt,
      amountMinor: outflowMinor,
      currency,
      rawDescriptor,
      accountId: IMPORT_ACCOUNT_ID,
      // A CSV export contains what posted. Nothing in it is pending, and claiming otherwise would
      // have the engine exclude every row by default.
      pending: false,
    });
  });

  return { transactions, droppedInflow, droppedUnreadable };
}

/**
 * A stable, UUID-shaped id for a row that has no database identity.
 *
 * UUID-shaped is not cosmetic. These ids end up in `detections.evidence.transactionIds`, and both
 * `review.supportingTransactions` and the confirm path feed that array to
 * `inArray(transactions.id, …)` against a `uuid` column — a non-UUID string there is a Postgres
 * cast error, so an imported detection would 500 the moment the user opened it. Shaped like a
 * UUID, it simply matches nothing: the evidence panel is empty and confirming stamps no rows,
 * which is the truth. The digest makes it deterministic, so re-importing the same file rewrites
 * the same evidence rather than churning it.
 */
function syntheticTransactionId(seed: string, index: number, row: ImportedRow): string {
  const digest = createHash('sha256')
    .update(`${seed}|${String(index)}|${row.postedAt}|${String(row.amountMinor)}|${row.descriptor}`)
    .digest('hex');
  // Version 5 in the version nibble and one of 8/9/a/b in the variant nibble, so the string is a
  // valid RFC 4122 UUID rather than 32 hex characters with hyphens in it.
  const variant = '89ab'.charAt(parseInt(digest.charAt(16), 16) % 4);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

// ── persistence ────────────────────────────────────────────────────────────────────────

/**
 * Where a detection row came from, stamped into the evidence blob.
 *
 * `detections` has no provenance column and the schema is frozen, so it rides in `evidence` —
 * which is already the "why do we believe this" bag and is read by the review queue. The value
 * matches `SUBSCRIPTION_SOURCES`' `csv_import`, so a confirmed detection and its subscription
 * describe their origin with the same word.
 */
export const CSV_PROVENANCE = 'csv_import';

type ImportEvidence = DetectionWrite['evidence'] & { readonly provenance: string };

export interface ImportContext {
  readonly db: Database;
  readonly scope: Scope;
  readonly clock: Clock;
}

/** One row of the preview: the claim, and enough evidence to judge it at a glance. */
export interface ImportedCandidate {
  readonly normalizedKey: string;
  /** The registry's merchant name when one matched, otherwise the normalised descriptor. */
  readonly displayName: string;
  readonly merchantId: string | null;
  readonly medianAmountMinor: number;
  readonly currency: string;
  readonly intervalUnit: IntervalUnit;
  readonly intervalCount: number;
  readonly occurrences: number;
  /** 0..1. */
  readonly confidence: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly sampleDescriptor: string;
}

export interface ImportSummary {
  /** Rows that reached the engine: everything the file had, less the two dropped counts. */
  readonly analysed: number;
  readonly candidates: number;
  readonly droppedInflow: number;
  readonly droppedUnreadable: number;
  /** Analysed rows that joined no recurring series. The Uber Eats orders. */
  readonly droppedOneOff: number;
  readonly signConvention: SignConvention;
  readonly negativeRows: number;
  readonly positiveRows: number;
  readonly inserted: number;
  readonly updated: number;
  /** Keys the user had already confirmed or dismissed. Their answer was left alone. */
  readonly preserved: number;
}

export interface ImportAnalysis {
  readonly summary: ImportSummary;
  readonly candidates: readonly ImportedCandidate[];
}

export interface AnalyseOptions {
  readonly rows: readonly ImportedRow[];
  readonly fallbackCurrency: string;
}

/**
 * Analyse a parsed file and fold the result into the review queue.
 *
 * The persistence half deliberately mirrors `reconcileDetections`: read what exists, `planDetections`
 * to decide the writes, upsert on `(user_id, normalized_key, currency)` **without** touching
 * `status`. That omission is the whole reason a dismissed suggestion stays dismissed when the same
 * file is imported twice.
 *
 * There is no `linkSubscriptions` step, and there cannot be: that stamps `transactions.subscription_id`,
 * and these rows are not in `transactions`. A user who also has a bank connection gets the links
 * from their next sync.
 */
export async function analyseImportedRows(
  ctx: ImportContext,
  options: AnalyseOptions,
): Promise<ImportAnalysis> {
  const sign = inferSignConvention(options.rows);
  const input = toDetectionInput(options.rows, {
    convention: sign.convention,
    fallbackCurrency: options.fallbackCurrency,
    seed: ctx.scope.userId,
  });

  const registry = await getMerchantRegistry(ctx.db, ctx.clock);
  const today = todayIn(ctx.clock, 'UTC');
  // Omitted rather than passed as undefined — `exactOptionalPropertyTypes` makes those different
  // things, and `DetectionOptions.registry` means "use none" only when the key is absent.
  const detectionOptions: DetectionOptions =
    registry === null ? { today } : { today, registry };

  const result = detectSubscriptions(input.transactions, detectionOptions);

  const existing = await listDetections(ctx);
  const plan = planDetections(result.candidates, existing);
  const written = await writeDetections(ctx, plan.writes);

  const claimed = new Set<string>();
  for (const candidate of result.candidates) {
    for (const id of candidate.transactionIds) claimed.add(id);
  }

  log.info(
    {
      rows: options.rows.length,
      analysed: input.transactions.length,
      candidates: result.candidates.length,
      convention: sign.convention,
    },
    'csv import analysed',
  );

  const names = merchantNames(registry?.all() ?? []);

  return {
    summary: {
      analysed: input.transactions.length,
      candidates: result.candidates.length,
      droppedInflow: input.droppedInflow,
      droppedUnreadable: input.droppedUnreadable,
      droppedOneOff: input.transactions.length - claimed.size,
      signConvention: sign.convention,
      negativeRows: sign.negativeRows,
      positiveRows: sign.positiveRows,
      inserted: written.inserted,
      updated: written.updated,
      preserved: plan.preservedKeys.length,
    },
    candidates: result.candidates.map((candidate) => toPreview(candidate, names)),
  };
}

function merchantNames(
  entries: readonly { readonly id: string; readonly name: string }[],
): ReadonlyMap<string, string> {
  return new Map(entries.map((entry) => [entry.id, entry.name]));
}

function toPreview(
  candidate: SubscriptionCandidate,
  names: ReadonlyMap<string, string>,
): ImportedCandidate {
  const merchantId = candidate.merchantMatch.merchantId;
  return {
    normalizedKey: candidate.normalizedKey,
    displayName:
      (merchantId === null ? undefined : names.get(merchantId)) ?? candidate.normalizedKey,
    merchantId,
    medianAmountMinor: candidate.medianAmountMinor,
    currency: candidate.currency,
    intervalUnit: candidate.interval.unit,
    intervalCount: candidate.interval.count,
    occurrences: candidate.occurrences,
    confidence: candidate.confidence,
    firstSeen: formatPlainDate(candidate.firstSeen),
    lastSeen: formatPlainDate(candidate.lastSeen),
    sampleDescriptor: candidate.sampleDescriptors[0] ?? candidate.normalizedKey,
  };
}

async function listDetections(ctx: ImportContext): Promise<readonly StoredDetection[]> {
  return ctx.db
    .select({
      id: detections.id,
      normalizedKey: detections.normalizedKey,
      currency: detections.currency,
      status: detections.status,
      subscriptionId: detections.subscriptionId,
    })
    .from(detections)
    .where(ctx.scope.where(detections));
}

interface WriteResult {
  readonly inserted: number;
  readonly updated: number;
}

/**
 * The upsert.
 *
 * Same conflict target and same update set as `DrizzleSyncStore.writeDetections`, with one
 * addition — the provenance stamp — which is the only reason this is not a call to that method.
 *
 * A key that already exists from a bank sync has its evidence replaced by this file's synthetic
 * transaction ids. That is a real, temporary loss: the review queue's evidence panel goes empty
 * for that row until the next sync's `reconcileDetections` writes the real ids back. It is
 * survivable and self-healing, which is more than can be said for the alternative of refusing to
 * update a detection because it was first seen somewhere else.
 */
async function writeDetections(
  ctx: ImportContext,
  writes: readonly DetectionWrite[],
): Promise<WriteResult> {
  if (writes.length === 0) return { inserted: 0, updated: 0 };

  const existing = await ctx.db
    .select({ normalizedKey: detections.normalizedKey, currency: detections.currency })
    .from(detections)
    .where(
      ctx.scope.where(
        detections,
        inArray(
          detections.normalizedKey,
          writes.map((write) => write.normalizedKey),
        ),
      ),
    );
  const known = new Set(existing.map((row) => detectionKey(row.normalizedKey, row.currency)));

  await ctx.db
    .insert(detections)
    .values(
      ctx.scope.ownAll(
        writes.map((write) => {
          const evidence: ImportEvidence = { ...write.evidence, provenance: CSV_PROVENANCE };
          return {
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
            evidence,
          };
        }),
      ),
    )
    .onConflictDoUpdate({
      target: [detections.userId, detections.normalizedKey, detections.currency],
      // `status` is absent, and that absence is the feature: a suggestion the user already
      // confirmed or dismissed keeps its answer however many times the file is re-imported.
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
    if (!known.has(detectionKey(write.normalizedKey, write.currency))) inserted += 1;
  }
  return { inserted, updated: writes.length - inserted };
}
