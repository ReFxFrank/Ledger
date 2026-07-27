import 'server-only';

import { and, count, eq, isNull } from 'drizzle-orm';
import {
  type AggregatorAdapter,
  type LinkSessionOptions,
  type SyncResult,
  DrizzleSyncStore,
  reconcileDetections,
  selectAdapter,
  syncConnection,
} from '@ledger/banking';
import {
  type Clock,
  type Category,
  type RecurrenceInterval,
  interval,
} from '@ledger/core';
import { type Database, type Scope, bankAccounts, bankConnections, detections, merchants } from '@ledger/db';
import { type MerchantRegistry, createInMemoryRegistry } from '@ledger/detection';
import { loadServerEnv } from '@ledger/env';
import { childLogger } from '@ledger/logger';

import {
  type ConnectionClaim,
  type LinkHandoff,
  type SyncTotals,
  accumulate,
  claimConnection,
  planLinkHandoff,
  shouldContinueInline,
} from './plan';

/**
 * The web app's half of `@ledger/banking`.
 *
 * The engine, the adapters, and every rule about cursors and idempotency live in that package.
 * What lives here is the wiring: which adapter this process runs, where the sealed token gets
 * written, and — the part worth reading carefully — the fact that a sync runs *inside the request*
 * rather than on a queue.
 *
 * ## Why the sync is inline, and what changes when a queue exists
 *
 * `runConnectionSync` below is the whole job. It takes a database, a scope, a clock and a target,
 * and it is deliberately free of anything request-shaped: no `ctx`, no headers, no tRPC error. The
 * two callers of it today are both tRPC mutations, and they call it *in-process* because there is
 * no Redis in this environment and a "connect a bank" button that queues work nobody will ever run
 * is worse than no button at all — the user would connect, see nothing, and conclude the product
 * is broken.
 *
 * When BullMQ is available, `apps/worker/src/jobs/sync.ts` calls `syncConnection` with the same
 * store, the same adapter and the same registry this file builds, and the mutation's body becomes
 * `enqueueSync(...)` in place of the `while` loop in `runConnectionSync`. Nothing else moves,
 * because nothing else knows which side of that line it is on. The bound in `MAX_INLINE_RUNS` is
 * the only piece that exists purely for the inline path, and it is named for that.
 *
 * Running it inline is defensible precisely because of what the store guarantees: the cursor is
 * written in the same Postgres transaction as the page it describes, so a request that times out
 * or a browser tab that closes mid-backfill leaves the connection resumable rather than
 * half-imported. A retry — the user pressing Sync — picks up where it stopped.
 */

const log = childLogger('web.banking');

// ── process-wide singletons ────────────────────────────────────────────────────────────

let adapterInstance: AggregatorAdapter | null = null;

/**
 * The adapter, built once.
 *
 * Once rather than per request because `FixtureAdapter` freezes its 24-month corpus the first time
 * a connection touches it, and paging hands out offsets into that frozen list. A fresh adapter per
 * request would regenerate the corpus against a moving clock, and page 4 would stop being the page
 * 4 that page 3's cursor pointed at.
 *
 * `loadServerEnv()` is called here rather than at module scope so that importing this file — which
 * the router does, which the authz test does — never depends on a populated `.env`.
 */
export function getAdapter(): AggregatorAdapter {
  adapterInstance ??= selectAdapter(loadServerEnv());
  return adapterInstance;
}

let storeInstance: DrizzleSyncStore | null = null;

function getStore(db: Database): DrizzleSyncStore {
  storeInstance ??= new DrizzleSyncStore(db);
  return storeInstance;
}

// ── the merchant registry ──────────────────────────────────────────────────────────────

/**
 * Built from the `merchants` **table**, never from the YAML in `@ledger/providers`.
 *
 * `detections.merchant_id` is a foreign key to `merchants.id`, and the detector writes whatever id
 * the registry gave it. A registry keyed by YAML slugs therefore produces detection rows that
 * cannot be inserted. Same reasoning, same shape, as `apps/worker/src/registry.ts`.
 */
const REGISTRY_TTL_MS = 15 * 60 * 1000;

let cachedRegistry: MerchantRegistry | null = null;
let registryLoadedAtMillis = Number.NEGATIVE_INFINITY;

async function getRegistry(db: Database, clock: Clock): Promise<MerchantRegistry | null> {
  if (cachedRegistry !== null && clock.epochMillis() - registryLoadedAtMillis < REGISTRY_TTL_MS) {
    return cachedRegistry;
  }

  try {
    const rows = await db
      .select({
        id: merchants.id,
        name: merchants.name,
        aliases: merchants.aliases,
        descriptorPatterns: merchants.descriptorPatterns,
        typicalIntervals: merchants.typicalIntervals,
        category: merchants.category,
      })
      .from(merchants)
      // A superseded merchant still resolves through the row that replaced it; registering both
      // would let an old descriptor match the dead one and stamp an id nothing links to.
      .where(isNull(merchants.supersededBy));

    cachedRegistry = createInMemoryRegistry(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        aliases: row.aliases,
        descriptorPatterns: row.descriptorPatterns,
        typicalIntervals: row.typicalIntervals.map((value): RecurrenceInterval =>
          interval(value.unit, value.count),
        ),
        category: row.category satisfies Category,
      })),
    );
    registryLoadedAtMillis = clock.epochMillis();
    return cachedRegistry;
  } catch (error) {
    // `detectSubscriptions` is documented to work without a registry. Refusing to sync because a
    // reference table was briefly unreadable is a worse outcome than weaker merchant matching.
    log.error(
      { err: error instanceof Error ? error.message : 'unknown' },
      'merchant registry load failed — detection continues without it',
    );
    return cachedRegistry;
  }
}

// ── the shared context ─────────────────────────────────────────────────────────────────

export interface BankingContext {
  readonly db: Database;
  readonly scope: Scope;
  readonly clock: Clock;
}

// ── link sessions ──────────────────────────────────────────────────────────────────────

export async function openLinkSession(
  ctx: BankingContext,
  options: LinkSessionOptions,
): Promise<LinkHandoff> {
  const adapter = getAdapter();
  return planLinkHandoff(await adapter.createLinkSession(ctx.scope.userId, options));
}

// ── exchanging a token for a connection ────────────────────────────────────────────────

export interface LinkedConnection {
  readonly claim: ConnectionClaim;
  readonly institutionName: string;
}

/**
 * Exchanges a public token and writes the `bank_connections` row.
 *
 * The access token is sealed by `@ledger/crypto` before it gets here: `AggregatorAdapter.
 * exchangeToken` seals inside the adapter and returns only the envelope, so the plaintext never
 * crosses a package boundary and no caller — including this one — is capable of logging it. The
 * AAD binding it is `aadFor('bank_connections', '<provider>:<externalItemId>', …)` rather than the
 * row's uuid, and that is forced by ordering: the token has to be sealed before the row it belongs
 * to exists. `bank_connections_item_unique` makes that pair exactly as unique as the primary key,
 * so the property is unchanged — ciphertext lifted from one connection and pasted into another
 * fails authentication instead of decrypting.
 *
 * No accounts are written here. `syncConnection` calls `getAccounts` and upserts them as its first
 * act, so writing them twice would only create a second place for the two to disagree.
 */
export async function linkConnection(
  ctx: BankingContext,
  publicToken: string,
  institutionId: string | null,
): Promise<LinkedConnection> {
  const adapter = getAdapter();
  const item = await adapter.exchangeToken(publicToken);
  const now = ctx.clock.now();

  const [inserted] = await ctx.db
    .insert(bankConnections)
    .values(
      ctx.scope.own({
        provider: item.provider,
        externalItemId: item.externalItemId,
        institutionId: institutionId ?? item.institutionId,
        institutionName: item.institutionName,
        institutionLogo: item.institutionLogo,
        status: 'active' as const,
        consentExpiresAt: item.consentExpiresAt,
        accessTokenCiphertext: item.accessTokenCiphertext,
        keyId: item.keyId,
        error: null,
      }),
    )
    .onConflictDoNothing({
      target: [bankConnections.provider, bankConnections.externalItemId],
    })
    .returning({ id: bankConnections.id });

  // Deliberately unscoped, and it can only be: this read is what *establishes* whose link the
  // aggregator's item id refers to. It returns two columns and neither is a secret, and the
  // decision made from it is `claimConnection`, which refuses anything not already ours.
  const [existing] =
    inserted === undefined
      ? await ctx.db
          .select({ id: bankConnections.id, userId: bankConnections.userId })
          .from(bankConnections)
          .where(
            and(
              eq(bankConnections.provider, item.provider),
              eq(bankConnections.externalItemId, item.externalItemId),
            ),
          )
          .limit(1)
      : [];

  const claim = claimConnection(inserted, existing, ctx.scope.userId);

  if (claim.kind === 'relinked') {
    // A reconnect re-seals a fresh token and clears whatever was wrong with the old one. Scoped,
    // so this cannot reach a row `claimConnection` just decided is not ours.
    await ctx.db
      .update(bankConnections)
      .set({
        institutionId: institutionId ?? item.institutionId,
        institutionName: item.institutionName,
        institutionLogo: item.institutionLogo,
        status: 'active',
        consentExpiresAt: item.consentExpiresAt,
        accessTokenCiphertext: item.accessTokenCiphertext,
        keyId: item.keyId,
        error: null,
        updatedAt: now,
      })
      .where(ctx.scope.whereId(bankConnections, claim.connectionId));
  }

  return { claim, institutionName: item.institutionName };
}

// ── the sync itself ────────────────────────────────────────────────────────────────────

export interface RunSyncOptions {
  /** Forget the stored cursor and re-read the whole window the aggregator will serve. */
  readonly full?: boolean;
  readonly maxRuns?: number;
}

export interface ConnectionSyncRun extends SyncTotals {
  readonly runs: number;
  readonly syncedAt: Date;
}

/**
 * Pulls everything available for one connection and reconciles detections.
 *
 * **This is the inline path**, and it is the function a BullMQ `sync` job would call unchanged —
 * see the note at the top of this file. `syncConnection` bounds itself at 40 pages per call and
 * reports `hasMore`; the loop here is the continuation the worker gets from re-enqueueing, bounded
 * by `MAX_INLINE_RUNS` because a request cannot run as long as a job can.
 *
 * `reconcileDetections` is what puts rows in `detections`, which is what gives `/review` something
 * to show. `syncConnection` runs it at the end of each run already; it is called again after the
 * loop only when the loop stopped early, so a partially-backfilled connection still gets whatever
 * the pages so far support rather than an empty review queue.
 */
export async function runConnectionSync(
  ctx: BankingContext,
  connectionId: string,
  options: RunSyncOptions = {},
): Promise<ConnectionSyncRun> {
  const adapter = getAdapter();
  const store = getStore(ctx.db);
  const registry = await getRegistry(ctx.db, ctx.clock);

  if (options.full === true) {
    // Re-reading from the beginning is safe rather than duplicative: every insert is
    // `ON CONFLICT DO NOTHING` against both `external_id` and `(account_id, dedupe_hash)`.
    await ctx.db
      .update(bankConnections)
      .set({ cursor: null, updatedAt: ctx.clock.now() })
      .where(ctx.scope.whereId(bankConnections, connectionId));
  }

  const context = {
    adapter,
    store,
    clock: ctx.clock,
    // Omitted rather than passed as undefined: `exactOptionalPropertyTypes` makes those different
    // things, and `SyncContext.registry` means "use none" only when the key is absent.
    ...(registry === null ? {} : { registry }),
    logger: log,
  };
  const target = { userId: ctx.scope.userId, connectionId };

  const results: SyncResult[] = [];
  for (;;) {
    const result = await syncConnection(context, target, {});
    results.push(result);
    if (!shouldContinueInline(result, results.length, options.maxRuns)) break;
  }

  const totals = accumulate(results);

  if (totals.hasMore) {
    // The budget ran out, not the aggregator. One more reconcile so the review queue reflects
    // every page that did land, instead of the user seeing an empty queue after a long wait.
    await reconcileDetections(context, ctx.scope.userId);
  }

  return { ...totals, runs: results.length, syncedAt: ctx.clock.now() };
}

// ── read-backs for the UI ──────────────────────────────────────────────────────────────

/** How many accounts a connection ended up with. Scoped through the connection, per §5. */
export async function countAccounts(ctx: BankingContext, connectionId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ value: count() })
    .from(bankAccounts)
    .where(ctx.scope.bankAccounts(eq(bankAccounts.connectionId, connectionId)));
  return row?.value ?? 0;
}

/** What `/review` would show right now. The number that makes the link to it worth following. */
export async function countPendingDetections(ctx: BankingContext): Promise<number> {
  const [row] = await ctx.db
    .select({ value: count() })
    .from(detections)
    .where(ctx.scope.where(detections, eq(detections.status, 'pending')));
  return row?.value ?? 0;
}
