import 'server-only';

import { eq, inArray } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { toDecimalString, money } from '@ledger/core';
import {
  attachments,
  bankAccounts,
  bankConnections,
  cancellationEvents,
  cancellationRequests,
  detections,
  paymentMethods,
  subscriptionPriceHistory,
  subscriptionShares,
  subscriptions,
  transactions,
  usageLogs,
  users,
} from '@ledger/db';
import { childLogger } from '@ledger/logger';
import { getAdapterFor } from '~/server/banking/runtime';
import { loadRevocableConnections, revokeConnections } from '~/server/banking/revoke';
import { recordAudit } from '../../audit';
import { router, sensitiveProcedure } from '../init';

const log = childLogger('account');

/**
 * Data rights (brief §9.6). Both procedures are `sensitiveProcedure`: they require a re-auth
 * inside the last fifteen minutes, because one hands over everything and the other destroys it.
 */

/** Minimal RFC 4180 CSV. Hand-written rather than a dependency — this is all it needs to do. */
function toCsv(rows: readonly Record<string, unknown>[]): string {
  const first = rows[0];
  if (first === undefined) return '';
  const headers = Object.keys(first);

  const render = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    // Arrays and jsonb columns land here. `String()` would render them `[object Object]` and
    // quietly drop the contents from the export — the user would get a file that looks complete.
    return JSON.stringify(value);
  };

  const cell = (value: unknown): string => {
    const text = render(value);
    // Quote when the value could otherwise break the row apart, and double any embedded quote.
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => cell(row[header])).join(',')),
  ].join('\n');
}

export const accountRouter = router({
  /**
   * Everything we hold, in one payload.
   *
   * Amounts are exported as both minor units and a decimal string. The minor units are the
   * truth; the decimal string is what a spreadsheet will read correctly without turning 1299
   * into twelve hundred and ninety-nine pounds.
   *
   * `bank_connections` is included, but only its identifying columns — never
   * `access_token_ciphertext` or `key_id`. An export is a file that ends up in a downloads
   * folder, and a sealed token is still a token.
   */
  exportData: sensitiveProcedure.query(async ({ ctx }) => {
    const [
      profile,
      subs,
      shares,
      priceHistory,
      usage,
      methods,
      connections,
      accounts,
      txns,
      detected,
      cancellations,
      cancellationTimeline,
      files,
    ] = await Promise.all([
      ctx.db.select().from(users).where(eq(users.id, ctx.user.id)).limit(1),
      ctx.db.select().from(subscriptions).where(ctx.scope.where(subscriptions)),
      ctx.db.select().from(subscriptionShares).where(ctx.scope.shares()),
      ctx.db.select().from(subscriptionPriceHistory).where(ctx.scope.priceHistory()),
      ctx.db.select().from(usageLogs).where(ctx.scope.usageLogs()),
      ctx.db.select().from(paymentMethods).where(ctx.scope.where(paymentMethods)),
      ctx.db
        .select({
          id: bankConnections.id,
          provider: bankConnections.provider,
          institutionName: bankConnections.institutionName,
          status: bankConnections.status,
          consentExpiresAt: bankConnections.consentExpiresAt,
          lastSyncedAt: bankConnections.lastSyncedAt,
          createdAt: bankConnections.createdAt,
        })
        .from(bankConnections)
        .where(ctx.scope.where(bankConnections)),
      ctx.db.select().from(bankAccounts).where(ctx.scope.bankAccounts()),
      ctx.db.select().from(transactions).where(ctx.scope.transactions()),
      ctx.db.select().from(detections).where(ctx.scope.where(detections)),
      ctx.db.select().from(cancellationRequests).where(ctx.scope.where(cancellationRequests)),
      ctx.db.select().from(cancellationEvents).where(ctx.scope.cancellationEvents()),
      ctx.db.select().from(attachments).where(ctx.scope.where(attachments)),
    ]);

    const owner = profile[0];
    if (owner === undefined) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found.' });
    }

    await recordAudit(
      ctx.db,
      ctx.scope,
      { ip: ctx.ip, userAgent: ctx.userAgent },
      'data.exported',
      'data',
      null,
      { subscriptions: subs.length, transactions: txns.length },
    );

    const decimal = (amountMinor: number, currency: string): string =>
      toDecimalString(money(amountMinor, currency));

    return {
      exportedAt: ctx.clock.now().toISOString(),
      format: 1,
      profile: {
        id: owner.id,
        name: owner.name,
        email: owner.email,
        displayCurrency: owner.displayCurrency,
        timezone: owner.timezone,
        locale: owner.locale,
        createdAt: owner.createdAt,
      },
      subscriptions: subs,
      subscriptionShares: shares,
      priceHistory,
      usageLogs: usage,
      paymentMethods: methods,
      bankConnections: connections,
      bankAccounts: accounts,
      transactions: txns,
      detections: detected,
      cancellationRequests: cancellations,
      cancellationEvents: cancellationTimeline,
      attachments: files,
      csv: {
        subscriptions: toCsv(
          subs.map((row) => ({
            name: row.displayName,
            status: row.status,
            amount: decimal(row.amountMinor, row.currency),
            amountMinor: row.amountMinor,
            currency: row.currency,
            interval: `${String(row.intervalCount)} ${row.intervalUnit}`,
            anchorDate: row.anchorDate,
            nextRenewalAt: row.nextRenewalAt,
            category: row.category,
            billingChannel: row.billingChannel,
            source: row.source,
            tags: row.tags.join(' '),
            notes: row.notes,
          })),
        ),
        transactions: toCsv(
          txns.map((row) => ({
            postedAt: row.postedAt,
            descriptor: row.rawDescriptor,
            normalizedKey: row.normalizedKey,
            amount: decimal(row.amountMinor, row.currency),
            amountMinor: row.amountMinor,
            currency: row.currency,
            billingChannel: row.billingChannel,
            pending: row.pending,
            subscriptionId: row.subscriptionId,
          })),
        ),
      },
    };
  }),

  /**
   * Delete the account, for real.
   *
   * Order matters and is the whole design of this procedure:
   *
   *  1. Revoke every upstream aggregator item FIRST. Deleting the local rows first would destroy
   *     the very tokens needed to revoke, leaving a live consent at the bank that nobody can
   *     withdraw — the local data would be gone and the access would not.
   *  2. Only then delete the user row, which cascades to everything else.
   *
   * If any revoke fails the deletion ABORTS rather than proceeding, because a half-deleted
   * account with live bank access is worse than an account that is still there. The abort is
   * per-institution, though: connections that *did* revoke are gone at the aggregator whatever
   * happens next, so their local rows are deleted immediately — a retry then only re-attempts
   * the ones that actually failed. `force` exists for the case where an aggregator is
   * permanently unreachable and the user would otherwise be stuck — it is an explicit choice,
   * and it is recorded.
   */
  deleteAccount: sensitiveProcedure
    .input(
      z.object({
        /** Typed by the user to confirm. Compared case-insensitively to their own address. */
        confirmEmail: z.string(),
        force: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.confirmEmail.trim().toLowerCase() !== ctx.user.email.toLowerCase()) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That is not the email address on this account.',
        });
      }

      // Marked closed immediately. `enforceSession` refuses every session from this point, so
      // there is no window where a deletion has been requested and the data is still being served.
      await ctx.db
        .update(users)
        .set({ deletedAt: ctx.clock.now() })
        .where(eq(users.id, ctx.user.id));

      // The sealed token columns are read in the banking layer, not here — `authz.test.ts`
      // bans their names in router sources, and the adapter opens the envelope internally, so
      // the plaintext never exists on this path at all.
      const links = await loadRevocableConnections(ctx.db, ctx.scope);

      const report = await revokeConnections(links, getAdapterFor);
      const revokedInstitutions = report.revoked.map((link) => link.institutionName);
      const unrevokedInstitutions = report.failed.map(({ connection }) => connection.institutionName);

      if (report.revoked.length > 0) {
        // Whatever happens next, these are gone at the aggregator — the sealed tokens in their
        // rows open nothing anymore. Deleting the rows now means a retry after a partial failure
        // only re-attempts the institutions that actually failed.
        await ctx.db
          .delete(bankConnections)
          .where(
            ctx.scope.where(
              bankConnections,
              inArray(
                bankConnections.id,
                report.revoked.map((link) => link.id),
              ),
            ),
          );
      }

      if (report.failed.length > 0 && !input.force) {
        // Undo the closure: the user asked to delete and we could not do it safely, so leaving
        // the account marked closed would lock them out of an account that still exists.
        await ctx.db.update(users).set({ deletedAt: null }).where(eq(users.id, ctx.user.id));

        // This entry survives, unlike the one below, and it is the record of the partial state:
        // some consents are already withdrawn while the account remains.
        await recordAudit(
          ctx.db,
          ctx.scope,
          { ip: ctx.ip, userAgent: ctx.userAgent },
          'account.delete_blocked',
          'account',
          null,
          { revokedInstitutions, unrevokedInstitutions },
        );

        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            `Could not disconnect ${unrevokedInstitutions.join(', ')}. Nothing was deleted — ` +
            'deleting now would remove your data here while leaving ' +
            (unrevokedInstitutions.length === 1 ? 'that bank' : 'those banks') +
            ' connected, and nothing left would be able to disconnect ' +
            (unrevokedInstitutions.length === 1 ? 'it' : 'them') +
            '. Try again in a few minutes, or use "Delete anyway" if it keeps failing.',
        });
      }

      log.warn(
        {
          userId: ctx.user.id,
          forced: input.force,
          revoked: revokedInstitutions.length,
          unrevoked: unrevokedInstitutions.length,
        },
        'deleting account',
      );

      // Written before the delete so the trail records which consents were withdrawn. The
      // cascade below takes the audit log with it — that is the data-rights design, not an
      // oversight — but the entry exists for the window between revoke and delete, and the
      // blocked-path entry above is the one that persists when persistence matters.
      await recordAudit(
        ctx.db,
        ctx.scope,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        'account.deleted',
        'account',
        null,
        { forced: input.force, revokedInstitutions, unrevokedInstitutions },
      );

      // Cascades: sessions, subscriptions, connections, transactions, detections, cancellations,
      // notifications, attachments, and the audit log itself.
      await ctx.db.delete(users).where(eq(users.id, ctx.user.id));

      return { deleted: true, revokedInstitutions, unrevokedInstitutions };
    }),
});
