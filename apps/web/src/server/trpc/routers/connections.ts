import 'server-only';

import { desc, eq, inArray } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { type ConnectionStatus } from '@ledger/core';
import { bankAccounts, bankConnections } from '@ledger/db';
import { recordAudit } from '~/server/audit';
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
  // The three procedures below are the whole of Ledger's contact with an aggregator, and their
  // signatures are fixed now so the /connections screen can be built against them. The bodies
  // land with workstream D. They throw rather than returning a plausible shape: a link session
  // that returns a fake token would fail three screens later, at the point where it is hardest
  // to tell a stub from a bug.

  /**
   * Opens a link session. `sensitiveProcedure` — connecting a bank is on the §9.2 list.
   *
   * TODO(frank): wire to @ledger/banking AggregatorAdapter once workstream D lands.
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
        linkToken: z.string(),
        expiresAt: z.date(),
        provider: z.string(),
      }),
    )
    .mutation(() => {
      throw new TRPCError({
        code: 'NOT_IMPLEMENTED',
        message: 'Bank connections are not switched on yet.',
      });
    }),

  /**
   * Exchanges the public token from the link flow for a stored connection.
   *
   * TODO(frank): wire to @ledger/banking AggregatorAdapter once workstream D lands.
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
      }),
    )
    .mutation(() => {
      throw new TRPCError({
        code: 'NOT_IMPLEMENTED',
        message: 'Bank connections are not switched on yet.',
      });
    }),

  /**
   * Pulls new transactions for one connection.
   *
   * TODO(frank): wire to @ledger/banking AggregatorAdapter once workstream D lands.
   */
  sync: protectedProcedure
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
        syncedAt: z.date(),
      }),
    )
    .mutation(() => {
      throw new TRPCError({
        code: 'NOT_IMPLEMENTED',
        message: 'Syncing is not switched on yet.',
      });
    }),
});
