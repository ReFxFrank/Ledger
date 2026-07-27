import 'server-only';

import { desc, eq, inArray } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { type AggregatorErrorCode, isAggregatorError } from '@ledger/banking';
import { type ConnectionStatus } from '@ledger/core';
import { bankAccounts, bankConnections } from '@ledger/db';
import { recordAudit } from '~/server/audit';
import {
  type BankingContext,
  countAccounts,
  countPendingDetections,
  linkConnection,
  openLinkSession,
  runConnectionSync,
} from '~/server/banking/runtime';
import { protectedProcedure, router, sensitiveProcedure } from '~/server/trpc/init';

/**
 * Bank connections (brief §7, /connections).
 *
 * Two things this file is careful about:
 *
 *  1. **`access_token_ciphertext` and `key_id` never leave the server.** Every read lists its
 *     columns explicitly instead of selecting the row, so adding a secret-bearing column to the
 *     table cannot leak it through an existing procedure by default.
 *  2. **Consent expiry is surfaced before it breaks.** Open-banking consent lapses on a fixed
 *     clock; a connection that only reports a problem after the first failed sync has already
 *     cost the user a gap in their transaction history.
 */

/** Warn this far ahead of consent lapsing. Matches `DEFAULT_LEAD_TIME_DAYS.consent_expiring`. */
const CONSENT_WARNING_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The columns any read may return. Deliberately not `bankConnections` — see the file header. */
const publicColumns = {
  id: bankConnections.id,
  provider: bankConnections.provider,
  institutionId: bankConnections.institutionId,
  institutionName: bankConnections.institutionName,
  institutionLogo: bankConnections.institutionLogo,
  status: bankConnections.status,
  consentExpiresAt: bankConnections.consentExpiresAt,
  lastSyncedAt: bankConnections.lastSyncedAt,
  backfillCompletedAt: bankConnections.backfillCompletedAt,
  error: bankConnections.error,
  createdAt: bankConnections.createdAt,
  updatedAt: bankConnections.updatedAt,
} as const;

export interface ConnectionHealth {
  readonly status: ConnectionStatus;
  /** Null when the provider does not expire consent, or has not told us when it will. */
  readonly daysUntilConsentExpiry: number | null;
  /** True when this needs the user to do something. Drives the attention badge. */
  readonly needsAttention: boolean;
}

/**
 * Health is derived on read, not stored.
 *
 * `consent_expiring` is a fact about the clock, and a stored status only becomes true when some
 * job happens to run. Deriving it means the moment a connection crosses fourteen days out, every
 * page that renders it says so — with no job in the loop at all.
 */
export function deriveHealth(
  status: ConnectionStatus,
  consentExpiresAt: Date | null,
  now: Date,
): ConnectionHealth {
  const daysUntilConsentExpiry =
    consentExpiresAt === null
      ? null
      : Math.floor((consentExpiresAt.getTime() - now.getTime()) / MS_PER_DAY);

  // A stored failure outranks the consent clock: "needs sign-in" is more actionable than
  // "consent expires in nine days", and showing both at once says nothing clearly.
  if (status !== 'active') {
    return { status, daysUntilConsentExpiry, needsAttention: status !== 'disconnected' };
  }

  if (daysUntilConsentExpiry !== null && daysUntilConsentExpiry < 0) {
    return { status: 'consent_expired', daysUntilConsentExpiry, needsAttention: true };
  }
  if (daysUntilConsentExpiry !== null && daysUntilConsentExpiry <= CONSENT_WARNING_DAYS) {
    return { status: 'consent_expiring', daysUntilConsentExpiry, needsAttention: true };
  }
  return { status: 'active', daysUntilConsentExpiry, needsAttention: false };
}

export const connectionsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const now = ctx.clock.now();

    const connections = await ctx.db
      .select(publicColumns)
      .from(bankConnections)
      .where(ctx.scope.where(bankConnections))
      .orderBy(desc(bankConnections.createdAt));

    if (connections.length === 0) return [];

    // One query for every account rather than one per connection: a user with five banks should
    // not cost five round trips to render a page that is mostly a list of account names.
    const accounts = await ctx.db
      .select({
        id: bankAccounts.id,
        connectionId: bankAccounts.connectionId,
        name: bankAccounts.name,
        officialName: bankAccounts.officialName,
        mask: bankAccounts.mask,
        type: bankAccounts.type,
        subtype: bankAccounts.subtype,
        currency: bankAccounts.currency,
        excludedFromDetection: bankAccounts.excludedFromDetection,
      })
      .from(bankAccounts)
      .where(
        ctx.scope.bankAccounts(
          inArray(
            bankAccounts.connectionId,
            connections.map((connection) => connection.id),
          ),
        ),
      )
      .orderBy(bankAccounts.name);

    return connections.map((connection) => ({
      ...connection,
      accounts: accounts.filter((account) => account.connectionId === connection.id),
      health: deriveHealth(connection.status, connection.consentExpiresAt, now),
    }));
  }),

  /**
   * Disconnects a bank.
   *
   * `sensitiveProcedure` because the cascade takes the accounts and every transaction with it,
   * and because §9.2 gates anything this irreversible behind a recent re-auth. The subscriptions
   * that were detected from those transactions survive — they are the user's records now, not
   * the bank's.
   */
  remove: sensitiveProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [removed] = await ctx.db
        .delete(bankConnections)
        .where(ctx.scope.whereId(bankConnections, input.id))
        .returning({ id: bankConnections.id, institutionName: bankConnections.institutionName });

      if (removed === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That connection does not exist.' });
      }

      await recordAudit(
        ctx.db,
        ctx.scope,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        'connection.removed',
        'connection',
        removed.id,
        { before: { institutionName: removed.institutionName } },
      );

      return { id: removed.id };
    }),

  /**
   * Excludes an account from detection — a business account, or a joint account whose charges
   * are somebody else's. It keeps syncing; detection just stops reading it.
   */
  setAccountExcluded: protectedProcedure
    .input(z.object({ accountId: z.string().uuid(), excluded: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(bankAccounts)
        .set({
          excludedFromDetection: input.excluded ? ctx.clock.now() : null,
          updatedAt: new Date(),
        })
        .where(ctx.scope.bankAccounts(eq(bankAccounts.id, input.accountId)))
        .returning({
          id: bankAccounts.id,
          name: bankAccounts.name,
          excludedFromDetection: bankAccounts.excludedFromDetection,
        });

      if (updated === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That account does not exist.' });
      }

      await recordAudit(
        ctx.db,
        ctx.scope,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        input.excluded ? 'account.excluded' : 'account.included',
        'account',
        updated.id,
        { after: { name: updated.name } },
      );

      return updated;
    }),

  // ── aggregator surface ────────────────────────────────────────────────────────────────
  //
  // The three procedures below are the whole of Ledger's contact with an aggregator. They run
  // against `selectAdapter(env)`, so the code path is identical for Plaid and for the fixture and
  // the only thing `AGGREGATOR=fixture` changes is which bank answers. Everything they touch —
  // sealing, the cursor, idempotency, detection — lives in @ledger/banking; what is here is the
  // wiring and the error translation.

  /**
   * Opens a link session. `sensitiveProcedure` — connecting a bank is on the §9.2 list.
   *
   * The output carries `mode` because the two providers genuinely differ and pretending otherwise
   * would mean building a fake bank picker. Plaid returns `handoff`: the token goes to its client
   * SDK, the user signs in at their own bank, and the SDK produces a public token to post back.
   * The fixture returns `immediate` with the public token already in hand, because there is no
   * bank to sign into and inventing a modal would test nothing.
   */
  createLinkSession: sensitiveProcedure
    .input(
      z
        .object({
          /** Pre-selects an institution when the user came from "reconnect". */
          institutionId: z.string().max(120).optional(),
          /** Set when re-authorising an existing connection rather than adding a new one. */
          connectionId: z.string().uuid().optional(),
        })
        .default({}),
    )
    .output(
      z.object({
        provider: z.string(),
        linkToken: z.string(),
        expiresAt: z.date(),
        mode: z.enum(['handoff', 'immediate']),
        publicToken: z.string().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return withAggregatorErrors(() =>
        openLinkSession(bankingContext(ctx), {
          clientName: 'Ledger',
          ...(input.institutionId === undefined ? {} : { institutionId: input.institutionId }),
        }),
      );
    }),

  /**
   * Exchanges the public token from the link flow for a stored connection, then backfills it.
   *
   * The backfill runs in this request. There is no Redis in this deployment, and a mutation that
   * queued work nothing would run is worse than none: the user would connect a bank, see an empty
   * screen, and be right to conclude it did not work. `runConnectionSync` is written so that the
   * queue's job body is the same call — see the note at the top of `~/server/banking/runtime`.
   */
  exchangeToken: sensitiveProcedure
    .input(
      z.object({
        publicToken: z.string().min(1),
        institutionId: z.string().max(120).optional(),
      }),
    )
    .output(
      z.object({
        connectionId: z.string().uuid(),
        institutionName: z.string(),
        accountCount: z.number().int(),
        /** True when this re-authorised a connection that already existed. */
        relinked: z.boolean(),
        transactionsAdded: z.number().int(),
        /** Detections that did not exist before this connect. */
        detectionsFound: z.number().int(),
        /** Everything now waiting in /review, including anything found earlier. */
        detectionsPending: z.number().int(),
        syncedAt: z.date(),
        /** The aggregator had more history than one request would spend. Press Sync again. */
        hasMore: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const banking = bankingContext(ctx);

      const linked = await withAggregatorErrors(() =>
        linkConnection(banking, input.publicToken, input.institutionId ?? null),
      );

      if (linked.claim.kind === 'taken') {
        // Deliberately not "that bank is already connected to another account" — that phrasing
        // confirms the existence of somebody else's connection to anyone holding a token.
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'That link cannot be used here. Start the connection again from this account.',
        });
      }

      const connectionId = linked.claim.connectionId;
      let totals = await withAggregatorErrors(() => runConnectionSync(banking, connectionId));

      /**
       * Let the initial backfill settle.
       *
       * Plaid prepares an Item's transaction history asynchronously after the exchange, and the
       * first `/transactions/sync` can legitimately return nothing. The documented signal that
       * data is ready is a webhook — which cannot reach a localhost deployment, and even in
       * production arrives seconds after this mutation has already answered. Without this loop a
       * fresh connect shows "12 accounts, 0 transactions imported", which reads as a broken
       * product rather than an upstream race. Observed live on the first real connect.
       *
       * Bounded and quiet: only on a brand-new, still-empty connection, three attempts, a few
       * seconds apart. A genuinely empty account stops after ~12s of patience and shows an
       * honest zero; the fixture never takes the first retry because its data is immediate.
       */
      const SETTLE_ATTEMPTS = 3;
      const SETTLE_DELAY_MS = 4000;
      for (
        let attempt = 0;
        attempt < SETTLE_ATTEMPTS &&
        linked.claim.kind !== 'relinked' &&
        totals.added === 0 &&
        !totals.hasMore;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
        totals = await withAggregatorErrors(() => runConnectionSync(banking, connectionId));
        if (totals.added > 0) break;
      }

      const [accountCount, detectionsPending] = await Promise.all([
        countAccounts(banking, connectionId),
        countPendingDetections(banking),
      ]);

      await recordAudit(
        ctx.db,
        ctx.scope,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        linked.claim.kind === 'relinked' ? 'connection.relinked' : 'connection.created',
        'connection',
        connectionId,
        {
          after: {
            institutionName: linked.institutionName,
            accountCount,
            transactionsAdded: totals.added,
            detectionsFound: totals.detectionsFound,
          },
        },
      );

      return {
        connectionId,
        institutionName: linked.institutionName,
        accountCount,
        relinked: linked.claim.kind === 'relinked',
        transactionsAdded: totals.added,
        detectionsFound: totals.detectionsFound,
        detectionsPending,
        syncedAt: totals.syncedAt,
        hasMore: totals.hasMore,
      };
    }),

  /**
   * Pulls new transactions for one connection and re-runs detection over the result.
   *
   * `sensitiveProcedure` alongside the other two. Refreshing a feed is not itself irreversible,
   * but this is the same call that performs the initial backfill and it is the only other way to
   * reach an aggregator with a stored token — putting it on a weaker gate than `exchangeToken`
   * would make the §9.2 boundary depend on which entry point somebody chose.
   */
  sync: sensitiveProcedure
    .input(
      z.object({
        connectionId: z.string().uuid(),
        /** Ignores the stored cursor and re-reads the full retention window. */
        full: z.boolean().default(false),
      }),
    )
    .output(
      z.object({
        added: z.number().int(),
        updated: z.number().int(),
        removed: z.number().int(),
        detectionsCreated: z.number().int(),
        detectionsPending: z.number().int(),
        pages: z.number().int(),
        hasMore: z.boolean(),
        syncedAt: z.date(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const banking = bankingContext(ctx);

      // Ownership is proven before the aggregator is touched. `syncConnection` scopes its own
      // load too, but it reports a missing connection as an upstream `item_not_found`, and a
      // NOT_FOUND is both truer and what the UI knows how to render.
      const [connection] = await ctx.db
        .select({ id: bankConnections.id })
        .from(bankConnections)
        .where(ctx.scope.whereId(bankConnections, input.connectionId))
        .limit(1);

      if (connection === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That connection does not exist.' });
      }

      const totals = await withAggregatorErrors(() =>
        runConnectionSync(banking, connection.id, { full: input.full }),
      );

      return {
        added: totals.added,
        updated: totals.updated,
        removed: totals.removed,
        detectionsCreated: totals.detectionsFound,
        detectionsPending: await countPendingDetections(banking),
        pages: totals.pages,
        hasMore: totals.hasMore,
        syncedAt: totals.syncedAt,
      };
    }),
});

// ── aggregator error translation ─────────────────────────────────────────────────────────

/**
 * The three fields `@ledger/banking` needs, lifted off the tRPC context.
 *
 * Narrowing rather than passing `ctx` whole: the sync engine has no business reaching a session,
 * a header, or an IP, and the only way to guarantee that is to not hand it one.
 */
function bankingContext(ctx: BankingContext): BankingContext {
  return { db: ctx.db, scope: ctx.scope, clock: ctx.clock };
}

/**
 * Which tRPC code an aggregator failure deserves.
 *
 * The distinction the UI needs is "can the user fix this now", and it is the reason these are not
 * all `INTERNAL_SERVER_ERROR`: a lapsed consent needs a reconnect button, a throttled aggregator
 * needs a retry in a minute, and a missing Plaid secret needs a deployment — showing the same
 * "something went wrong" for all three leaves the user with no next step in any of them.
 */
const AGGREGATOR_ERROR_CODES_TO_TRPC: Readonly<
  Record<AggregatorErrorCode, TRPCError['code']>
> = {
  reauth_required: 'FORBIDDEN',
  consent_expired: 'FORBIDDEN',
  item_not_found: 'NOT_FOUND',
  temporarily_unavailable: 'TIMEOUT',
  rate_limited: 'TOO_MANY_REQUESTS',
  invalid_webhook: 'BAD_REQUEST',
  not_configured: 'PRECONDITION_FAILED',
  upstream: 'BAD_GATEWAY',
};

/**
 * Runs `work`, turning an `AggregatorError` into a tRPC error.
 *
 * Only the sanitised code and message cross over. An aggregator's own error object carries the
 * request that produced it, and that request carries the access token — which is why
 * `AggregatorError` never attaches a `cause` and why nothing here goes looking for one.
 */
async function withAggregatorErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (!isAggregatorError(cause)) throw cause;
    throw new TRPCError({
      code: AGGREGATOR_ERROR_CODES_TO_TRPC[cause.aggregatorCode],
      message: cause.message,
    });
  }
}
