import 'server-only';

import { and, asc, desc, eq, gte, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  type CommitmentInput,
  aggregateCommitments,
  addDays,
  formatPlainDate,
  fromInstant,
  interval,
  occurrencesBetween,
  parsePlainDate,
  fallbackSnapshotFor,
  staticFallbackRates,
  toInstant,
} from '@ledger/core';
import { bankConnections, detections, subscriptionPriceHistory, subscriptions } from '@ledger/db';
import { protectedProcedure, router } from '../init';

/**
 * FX comes from the static quarterly fallback snapshot in @ledger/core, not a live feed.
 *
 * TODO(frank): the real fix is still a daily rate job writing into an `fx_rates` table keyed by
 * date — a small piece of work once there is a rate source to point at. Until then the fallback
 * converts the majors at a dated indicative rate, the payload names which rows that applied to,
 * and the UI says "converted at an indicative rate from <date>" rather than presenting the
 * figure as fact. Anything outside the snapshot still lands in `unconvertible` and is surfaced —
 * never converted at 1.0, because a silently wrong total is worse than a labelled approximation.
 */

export const dashboardRouter = router({
  /**
   * The Billing Horizon (brief §6.1): every charge in the next N days, as ticks on a timeline.
   *
   * Projected from each subscription's anchor rather than read from `next_renewal_at`, because
   * the horizon needs *all* the occurrences in the window — a weekly subscription contributes
   * eight or nine ticks, not one.
   */
  horizon: protectedProcedure
    .input(z.object({ days: z.number().int().min(7).max(180).default(60) }).default({}))
    .query(async ({ ctx, input }) => {
      const timezone = ctx.user.timezone ?? 'UTC';
      const today = fromInstant(ctx.clock.now(), timezone);
      const until = addDays(today, input.days);

      const rows = await ctx.db
        .select()
        .from(subscriptions)
        .where(
          ctx.scope.where(
            subscriptions,
            isNull(subscriptions.archivedAt),
            sql`${subscriptions.status} in ('active','trialing','cancel_scheduled')`,
          ),
        );

      const ticks = rows.flatMap((row) =>
        occurrencesBetween(
          parsePlainDate(row.anchorDate),
          interval(row.intervalUnit, row.intervalCount),
          today,
          until,
        ).map((date) => ({
          date: formatPlainDate(date),
          subscriptionId: row.id,
          displayName: row.displayName,
          amountMinor: row.amountMinor,
          currency: row.currency,
          category: row.category,
          status: row.status,
          variableAmount: row.variableAmount,
          isTrialConversion:
            row.trialEndsAt !== null &&
            formatPlainDate(fromInstant(row.trialEndsAt, timezone)) === formatPlainDate(date),
        })),
      );

      ticks.sort((a, b) => a.date.localeCompare(b.date) || a.displayName.localeCompare(b.displayName));

      return { from: formatPlainDate(today), to: formatPlainDate(until), ticks };
    }),

  totals: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(subscriptions)
      .where(ctx.scope.where(subscriptions, isNull(subscriptions.archivedAt)));

    const inputs: CommitmentInput[] = rows.map((row) => ({
      id: row.id,
      amountMinor: row.amountMinor,
      currency: row.currency,
      interval: interval(row.intervalUnit, row.intervalCount),
      status: row.status,
      category: row.category,
    }));

    const asOf = formatPlainDate(fromInstant(ctx.clock.now(), ctx.user.timezone ?? 'UTC'));
    const totals = aggregateCommitments(inputs, {
      displayCurrency: ctx.user.displayCurrency ?? 'USD',
      rates: staticFallbackRates(asOf),
      asOf,
    });

    return {
      monthlyMinor: totals.monthly.amountMinor,
      annualMinor: totals.annual.amountMinor,
      currency: totals.monthly.currency,
      count: totals.count,
      // Surfaced, not swallowed — the UI says "3 subscriptions aren't included in this total".
      unconvertibleIds: totals.unconvertible,
      // Converted at the static fallback rate, so the total is approximate about exactly these —
      // the UI labels them "converted at an indicative rate from <approximateRateDate>".
      approximateIds: totals.converted,
      approximateRateDate: fallbackSnapshotFor(asOf).asOf,
    };
  }),

  /**
   * The attention queue.
   *
   * Everything that needs a decision today, in one query set. An empty result is a *good*
   * state and the UI says so rather than showing an apology.
   */
  attention: protectedProcedure.query(async ({ ctx }) => {
    const timezone = ctx.user.timezone ?? 'UTC';
    const now = ctx.clock.now();
    const today = fromInstant(now, timezone);

    const [trialsEnding, cancelBySoon, recentPriceChanges, pendingDetections, failedConnections] =
      await Promise.all([
        ctx.db
          .select()
          .from(subscriptions)
          .where(
            ctx.scope.where(
              subscriptions,
              eq(subscriptions.status, 'trialing'),
              isNull(subscriptions.archivedAt),
              lte(subscriptions.trialEndsAt, toInstant(addDays(today, 7), timezone, 23)),
            ),
          )
          .orderBy(asc(subscriptions.trialEndsAt)),

        ctx.db
          .select()
          .from(subscriptions)
          .where(
            ctx.scope.where(
              subscriptions,
              isNull(subscriptions.archivedAt),
              lte(subscriptions.cancelByAt, toInstant(addDays(today, 14), timezone, 23)),
              gte(subscriptions.cancelByAt, toInstant(addDays(today, -30), timezone, 0)),
            ),
          )
          .orderBy(asc(subscriptions.cancelByAt)),

        ctx.db
          .select({
            history: subscriptionPriceHistory,
            displayName: subscriptions.displayName,
            subscriptionId: subscriptions.id,
          })
          .from(subscriptionPriceHistory)
          .innerJoin(subscriptions, eq(subscriptionPriceHistory.subscriptionId, subscriptions.id))
          .where(
            ctx.scope.where(
              subscriptions,
              gte(subscriptionPriceHistory.effectiveFrom, formatPlainDate(addDays(today, -60))),
              // 300bp = the 3% threshold from brief §4.4, in either direction.
              or(
                gte(subscriptionPriceHistory.deltaBps, 300),
                lte(subscriptionPriceHistory.deltaBps, -300),
              ),
            ),
          )
          .orderBy(desc(subscriptionPriceHistory.effectiveFrom))
          .limit(20),

        ctx.db
          .select({ count: sql<number>`count(*)::int` })
          .from(detections)
          .where(ctx.scope.where(detections, eq(detections.status, 'pending'))),

        ctx.db
          // Columns listed explicitly, never the whole row: `bank_connections` carries
          // `access_token_ciphertext` and `key_id`, and a bare `select()` would hand both to the
          // browser. `authz.test.ts` fails the build if this ever becomes a whole-row read.
          .select({
            id: bankConnections.id,
            provider: bankConnections.provider,
            institutionName: bankConnections.institutionName,
            institutionLogo: bankConnections.institutionLogo,
            status: bankConnections.status,
            consentExpiresAt: bankConnections.consentExpiresAt,
            lastSyncedAt: bankConnections.lastSyncedAt,
            error: bankConnections.error,
          })
          .from(bankConnections)
          .where(ctx.scope.where(bankConnections, ne(bankConnections.status, 'active'))),
      ]);

    return {
      trialsEnding,
      cancelBySoon,
      priceChanges: recentPriceChanges,
      pendingDetectionCount: pendingDetections[0]?.count ?? 0,
      unhealthyConnections: failedConnections,
    };
  }),

  recentChanges: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }).default({}))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(subscriptions)
        .where(ctx.scope.where(subscriptions, isNull(subscriptions.archivedAt)))
        .orderBy(desc(subscriptions.updatedAt))
        .limit(input.limit);
    }),
});

export { and };
