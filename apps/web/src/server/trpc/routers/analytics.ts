import 'server-only';

import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  type AggregateOptions,
  type Clock,
  type CommitmentInput,
  addDays,
  aggregateByCategory,
  aggregateCommitments,
  costPerUse,
  formatPlainDate,
  fromInstant,
  interval,
  intervalLabel,
  money,
  multiply,
  occurrencesBetween,
  parsePlainDate,
  simulateCancellations,
  staticRateTable,
  toInstant,
} from '@ledger/core';
import {
  type Database,
  type Scope,
  subscriptionShares,
  subscriptions,
  transactions,
  usageLogs,
} from '@ledger/db';
import { protectedProcedure, router } from '~/server/trpc/init';

/**
 * Analytics (brief §7, /analytics).
 *
 * Every commitment figure on this page comes out of `aggregateCommitments` /
 * `aggregateByCategory` in @ledger/core — the same functions the dashboard totals and the
 * subscriptions table use. That is not tidiness: brief Phase 8 requires every figure to
 * reconcile exactly with the subscriptions table, and the only way to guarantee that is to have
 * one summation rather than two that agree today.
 *
 * The one thing here that is *not* a commitment figure is `spendOverTime`, which reads posted
 * transactions. That is money that actually left, not money promised — a different question,
 * and it is summed in SQL because there is nothing to annualize.
 */

/** See the dashboard router: FX rates are an empty table until there is a rate source. */
const RATES = staticRateTable([]);

interface Portfolio {
  readonly inputs: CommitmentInput[];
  readonly options: AggregateOptions;
}

interface PortfolioContext {
  readonly db: Database;
  readonly scope: Scope;
  readonly clock: Clock;
  readonly user: {
    readonly displayCurrency?: string | null | undefined;
    readonly timezone?: string | null | undefined;
  };
}

/**
 * The portfolio, loaded once, in the shape @ledger/core wants.
 *
 * The user's own share is folded in here rather than at each call site, so "what this costs the
 * household" and "what this costs me" are two fields of one aggregation instead of two queries
 * that drift apart the first time somebody edits only one of them.
 */
async function portfolioFor(ctx: PortfolioContext): Promise<Portfolio> {
  const timezone = ctx.user.timezone ?? 'UTC';

  const [rows, selfShares] = await Promise.all([
    ctx.db
      .select()
      .from(subscriptions)
      .where(ctx.scope.where(subscriptions, isNull(subscriptions.archivedAt))),
    ctx.db
      .select({
        subscriptionId: subscriptionShares.subscriptionId,
        shareMinor: subscriptionShares.shareMinor,
      })
      .from(subscriptionShares)
      .where(ctx.scope.shares(eq(subscriptionShares.isSelf, true))),
  ]);

  const selfBySubscription = new Map(
    selfShares.map((share) => [share.subscriptionId, share.shareMinor]),
  );

  const inputs: CommitmentInput[] = rows.map((row) => {
    const selfShareMinor = selfBySubscription.get(row.id);
    return {
      id: row.id,
      amountMinor: row.amountMinor,
      currency: row.currency,
      interval: interval(row.intervalUnit, row.intervalCount),
      status: row.status,
      category: row.category,
      // Spread rather than assigned: `exactOptionalPropertyTypes` treats an explicit
      // `undefined` as a different thing from an absent key, and the default is "no split".
      ...(selfShareMinor === undefined ? {} : { selfShareMinor }),
    };
  });

  return {
    inputs,
    options: {
      displayCurrency: ctx.user.displayCurrency ?? 'USD',
      rates: RATES,
      asOf: formatPlainDate(fromInstant(ctx.clock.now(), timezone)),
    },
  };
}

export const analyticsRouter = router({
  /** Spend by category. Sorted by annual cost descending inside `aggregateByCategory`. */
  spendByCategory: protectedProcedure.query(async ({ ctx }) => {
    const portfolio = await portfolioFor(ctx);
    const totals = aggregateByCategory(portfolio.inputs, portfolio.options);

    return totals.map((total) => ({
      category: total.category,
      monthlyMinor: total.monthly.amountMinor,
      annualMinor: total.annual.amountMinor,
      currency: total.monthly.currency,
      count: total.count,
    }));
  }),

  /**
   * How the portfolio splits across billing cadences.
   *
   * Weekly and 4-weekly are the interesting rows: they are the ones people mentally file as
   * "monthly" and are 13 or 52 charges a year, not 12.
   */
  cadenceMix: protectedProcedure.query(async ({ ctx }) => {
    const portfolio = await portfolioFor(ctx);

    const buckets = new Map<string, CommitmentInput[]>();
    for (const input of portfolio.inputs) {
      const key = `${input.interval.unit}:${String(input.interval.count)}`;
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [input]);
      else bucket.push(input);
    }

    return [...buckets.entries()]
      .map(([key, group]) => {
        const first = group[0];
        // A bucket is only created by pushing a row into it, so this cannot be empty — the
        // check is here because `noUncheckedIndexedAccess` is right that the compiler cannot
        // know that.
        if (first === undefined) return null;
        const totals = aggregateCommitments(group, portfolio.options);
        return {
          key,
          unit: first.interval.unit,
          count: first.interval.count,
          label: intervalLabel(first.interval),
          monthlyMinor: totals.monthly.amountMinor,
          annualMinor: totals.annual.amountMinor,
          currency: totals.monthly.currency,
          subscriptions: totals.count,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.annualMinor - a.annualMinor);
  }),

  /**
   * What actually left the account, by month.
   *
   * Read from `transactions`, not projected from subscriptions, because the point of this chart
   * is to show the difference — a month with a missed charge or a double charge should look
   * different here from the commitment total, and a projection would hide exactly that.
   *
   * Grouped by currency as well as month: summing mixed currencies naively is forbidden
   * (brief §4.4), and there is no rate table to convert with yet.
   */
  spendOverTime: protectedProcedure
    .input(
      z
        .object({
          months: z.number().int().min(1).max(36).default(12),
          /** Only charges matched to a subscription. Off by default — the total is the point. */
          subscriptionsOnly: z.boolean().default(false),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const timezone = ctx.user.timezone ?? 'UTC';
      const today = fromInstant(ctx.clock.now(), timezone);
      // Approximate month length is fine for a window boundary; the bucketing itself is done by
      // Postgres against real calendar months.
      const from = toInstant(addDays(today, -Math.round(input.months * 30.4375)), timezone, 0);

      const rows = await ctx.db
        .select({
          month: sql<string>`to_char(date_trunc('month', ${transactions.postedAt}), 'YYYY-MM')`,
          currency: transactions.currency,
          totalMinor: sql<number>`coalesce(sum(${transactions.amountMinor}), 0)::bigint::int`,
          charges: sql<number>`count(*)::int`,
        })
        .from(transactions)
        .where(
          ctx.scope.transactions(
            and(
              gte(transactions.postedAt, from),
              eq(transactions.pending, false),
              input.subscriptionsOnly ? sql`${transactions.subscriptionId} is not null` : undefined,
            ),
          ),
        )
        .groupBy(
          sql`date_trunc('month', ${transactions.postedAt})`,
          transactions.currency,
        )
        .orderBy(sql`date_trunc('month', ${transactions.postedAt}) asc`);

      return rows;
    }),

  /**
   * Cost per use — the number that makes someone cancel.
   *
   * Spend over the window is the charges that actually fall in it, counted with
   * `occurrencesBetween` and multiplied in integer space. Not "monthly cost × 3": a quarterly
   * subscription contributes one charge to a 90-day window or two, depending on where the
   * anchor sits, and averaging that away is how the figure stops being believable.
   */
  costPerUse: protectedProcedure
    .input(z.object({ days: z.number().int().min(30).max(365).default(90) }).default({}))
    .query(async ({ ctx, input }) => {
      const timezone = ctx.user.timezone ?? 'UTC';
      const now = ctx.clock.now();
      const today = fromInstant(now, timezone);
      const windowStart = addDays(today, -input.days);

      const [rows, uses] = await Promise.all([
        ctx.db
          .select()
          .from(subscriptions)
          .where(ctx.scope.where(subscriptions, isNull(subscriptions.archivedAt))),
        ctx.db
          .select({
            subscriptionId: usageLogs.subscriptionId,
            count: sql<number>`count(*)::int`,
          })
          .from(usageLogs)
          .where(ctx.scope.usageLogs(gte(usageLogs.occurredAt, toInstant(windowStart, timezone, 0))))
          .groupBy(usageLogs.subscriptionId),
      ]);

      const usesBySubscription = new Map(uses.map((row) => [row.subscriptionId, row.count]));

      return rows
        .map((row) => {
          const charges = occurrencesBetween(
            parsePlainDate(row.anchorDate),
            interval(row.intervalUnit, row.intervalCount),
            windowStart,
            today,
          ).length;

          const spend = multiply(money(row.amountMinor, row.currency), charges);
          const used = usesBySubscription.get(row.id) ?? 0;
          const perUse = costPerUse(spend, used);

          return {
            id: row.id,
            displayName: row.displayName,
            category: row.category,
            status: row.status,
            currency: row.currency,
            windowSpendMinor: spend.amountMinor,
            charges,
            uses: used,
            // Null means "never used" — the UI says that, rather than showing a division
            // artifact or an infinity.
            costPerUseMinor: perUse === null ? null : perUse.amountMinor,
          };
        })
        // Never-used first — "paid for, never opened" is the strongest signal on the page —
        // then by cost per use descending. Sorting nulls as Infinity would make the comparator
        // return NaN for two unused rows, which is undefined behaviour, not a tie.
        .sort((a, b) => {
          if (a.costPerUseMinor === null && b.costPerUseMinor === null) {
            return b.windowSpendMinor - a.windowSpendMinor;
          }
          if (a.costPerUseMinor === null) return -1;
          if (b.costPerUseMinor === null) return 1;
          return b.costPerUseMinor - a.costPerUseMinor;
        });
    }),

  /**
   * The cancel simulator.
   *
   * Runs the same aggregation over the portfolio with and without the selected rows, so a
   * currency that cannot be converted is excluded from both sides consistently and the
   * difference stays honest.
   */
  simulate: protectedProcedure
    .input(z.object({ cancelIds: z.array(z.string().uuid()).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const portfolio = await portfolioFor(ctx);
      const result = simulateCancellations(portfolio.inputs, input.cancelIds, portfolio.options);

      return {
        beforeMonthlyMinor: result.before.monthly.amountMinor,
        beforeAnnualMinor: result.before.annual.amountMinor,
        afterMonthlyMinor: result.after.monthly.amountMinor,
        afterAnnualMinor: result.after.annual.amountMinor,
        reclaimedMonthlyMinor: result.reclaimedMonthly.amountMinor,
        reclaimedAnnualMinor: result.reclaimedAnnual.amountMinor,
        currency: result.before.monthly.currency,
        countBefore: result.before.count,
        countAfter: result.after.count,
        unconvertibleIds: result.before.unconvertible,
      };
    }),
});
