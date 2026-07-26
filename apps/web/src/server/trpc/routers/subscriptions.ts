import 'server-only';

import { asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  CATEGORIES,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
  formatPlainDate,
  fromInstant,
  interval,
  nextOccurrenceAfter,
  parsePlainDate,
  relativeChangeBps,
  toInstant,
  money,
} from '@ledger/core';
import {
  type Database,
  type Scope,
  type TransitionTrigger,
  merchants,
  subscriptionPriceHistory,
  subscriptionShares,
  subscriptions,
  transition,
  usageLogs,
} from '@ledger/db';
import { recordAudit } from '../../audit';
import { protectedProcedure, router } from '../init';

const intervalUnit = z.enum(['day', 'week', 'month', 'year']);

const subscriptionInput = z.object({
  displayName: z.string().min(1).max(120),
  merchantId: z.string().uuid().nullish(),
  amountMinor: z.number().int(),
  currency: z.string().length(3),
  intervalUnit,
  intervalCount: z.number().int().min(1).max(365),
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(SUBSCRIPTION_STATUSES).default('active'),
  category: z.enum(CATEGORIES).default('other'),
  billingChannel: z
    .enum(['direct', 'apple', 'google', 'amazon', 'paypal', 'roku', 'carrier', 'microsoft', 'steam', 'unknown'])
    .default('unknown'),
  paymentMethodId: z.string().uuid().nullish(),
  trialEndsAt: z.date().nullish(),
  autoRenew: z.boolean().default(true),
  variableAmount: z.boolean().default(false),
  notes: z.string().max(4000).nullish(),
  url: z.string().url().nullish(),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
});

/**
 * Renewal projection.
 *
 * Always recomputed from the anchor rather than incremented from the stored value — a stored
 * `next_renewal_at` that has been stepped forward N times has accumulated N clamping errors,
 * and the whole point of anchoring is that it cannot.
 */
function projectRenewal(
  anchorDate: string,
  unit: 'day' | 'week' | 'month' | 'year',
  count: number,
  timezone: string,
  now: Date,
): Date {
  const anchor = parsePlainDate(anchorDate);
  const today = fromInstant(now, timezone);
  const next = nextOccurrenceAfter(anchor, interval(unit, count), today);
  return toInstant(next, timezone, 9); // 09:00 local — a charge lands during the day, not at midnight
}

export const subscriptionsRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          search: z.string().max(120).optional(),
          statuses: z.array(z.enum(SUBSCRIPTION_STATUSES)).optional(),
          categories: z.array(z.enum(CATEGORIES)).optional(),
          tags: z.array(z.string()).optional(),
          includeArchived: z.boolean().default(false),
          sort: z.enum(['name', 'amount', 'nextRenewal', 'created']).default('nextRenewal'),
          direction: z.enum(['asc', 'desc']).default('asc'),
          limit: z.number().int().min(1).max(500).default(200),
          cursor: z.number().int().min(0).default(0),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const filters = [
        input.includeArchived ? undefined : isNull(subscriptions.archivedAt),
        input.statuses?.length ? inArray(subscriptions.status, input.statuses) : undefined,
        input.categories?.length ? inArray(subscriptions.category, input.categories) : undefined,
        input.tags?.length ? sql`${subscriptions.tags} && ${input.tags}` : undefined,
        input.search
          ? or(
              ilike(subscriptions.displayName, `%${input.search}%`),
              ilike(subscriptions.notes, `%${input.search}%`),
            )
          : undefined,
      ];

      const orderColumn = {
        name: subscriptions.displayName,
        amount: subscriptions.amountMinor,
        nextRenewal: subscriptions.nextRenewalAt,
        created: subscriptions.createdAt,
      }[input.sort];

      const rows = await ctx.db
        .select({
          subscription: subscriptions,
          merchantName: merchants.name,
          merchantSlug: merchants.slug,
          merchantLogo: merchants.logoUrl,
        })
        .from(subscriptions)
        .leftJoin(merchants, eq(subscriptions.merchantId, merchants.id))
        .where(ctx.scope.where(subscriptions, ...filters))
        .orderBy(input.direction === 'asc' ? asc(orderColumn) : desc(orderColumn))
        .limit(input.limit)
        .offset(input.cursor);

      return {
        items: rows,
        nextCursor: rows.length === input.limit ? input.cursor + input.limit : null,
      };
    }),

  byId: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({ subscription: subscriptions, merchant: merchants })
        .from(subscriptions)
        .leftJoin(merchants, eq(subscriptions.merchantId, merchants.id))
        .where(ctx.scope.whereId(subscriptions, input.id))
        .limit(1);

      if (row === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That subscription does not exist.' });
      }

      const [shares, history, usage] = await Promise.all([
        ctx.db
          .select()
          .from(subscriptionShares)
          .where(eq(subscriptionShares.subscriptionId, input.id))
          .orderBy(desc(subscriptionShares.isSelf)),
        ctx.db
          .select()
          .from(subscriptionPriceHistory)
          .where(eq(subscriptionPriceHistory.subscriptionId, input.id))
          .orderBy(asc(subscriptionPriceHistory.effectiveFrom)),
        ctx.db
          .select()
          .from(usageLogs)
          .where(eq(usageLogs.subscriptionId, input.id))
          .orderBy(desc(usageLogs.occurredAt))
          .limit(100),
      ]);

      return { ...row, shares, priceHistory: history, usage };
    }),

  create: protectedProcedure.input(subscriptionInput).mutation(async ({ ctx, input }) => {
    const timezone = ctx.user.timezone ?? 'UTC';
    const nextRenewalAt = projectRenewal(
      input.anchorDate,
      input.intervalUnit,
      input.intervalCount,
      timezone,
      ctx.clock.now(),
    );

    const [created] = await ctx.db
      .insert(subscriptions)
      .values(
        ctx.scope.own({
          displayName: input.displayName,
          merchantId: input.merchantId ?? null,
          amountMinor: input.amountMinor,
          currency: input.currency.toUpperCase(),
          intervalUnit: input.intervalUnit,
          intervalCount: input.intervalCount,
          anchorDate: input.anchorDate,
          nextRenewalAt,
          status: input.status,
          category: input.category,
          billingChannel: input.billingChannel,
          paymentMethodId: input.paymentMethodId ?? null,
          trialEndsAt: input.trialEndsAt ?? null,
          autoRenew: input.autoRenew,
          variableAmount: input.variableAmount,
          notes: input.notes ?? null,
          url: input.url ?? null,
          tags: input.tags,
          source: 'manual',
          confidence: '1.000',
        }),
      )
      .returning();

    if (created === undefined) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Could not save that.' });
    }

    // The first price point, so the history chart has a starting value rather than an empty
    // state that only fills in after the provider raises the price.
    await ctx.db.insert(subscriptionPriceHistory).values({
      subscriptionId: created.id,
      amountMinor: created.amountMinor,
      currency: created.currency,
      effectiveFrom: created.anchorDate,
      deltaBps: null,
      source: 'manual',
    });

    await writeAudit(ctx, 'subscription.created', created.id, { after: created.displayName });
    return created;
  }),

  update: protectedProcedure
    .input(z.object({ id: z.string().uuid(), patch: subscriptionInput.partial() }))
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select()
        .from(subscriptions)
        .where(ctx.scope.whereId(subscriptions, input.id))
        .limit(1);

      if (existing === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That subscription does not exist.' });
      }

      // A status change goes through the state machine, so an impossible move is refused here
      // rather than quietly written.
      if (input.patch.status !== undefined && input.patch.status !== existing.status) {
        assertStatusChange(existing.status, input.patch.status);
      }

      const anchorDate = input.patch.anchorDate ?? existing.anchorDate;
      const unit = input.patch.intervalUnit ?? existing.intervalUnit;
      const count = input.patch.intervalCount ?? existing.intervalCount;

      const [updated] = await ctx.db
        .update(subscriptions)
        .set({
          ...input.patch,
          currency: input.patch.currency?.toUpperCase(),
          anchorDate,
          intervalUnit: unit,
          intervalCount: count,
          nextRenewalAt: projectRenewal(anchorDate, unit, count, ctx.user.timezone ?? 'UTC', ctx.clock.now()),
          updatedAt: new Date(),
        })
        .where(ctx.scope.whereId(subscriptions, input.id))
        .returning();

      if (updated === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That subscription does not exist.' });
      }

      // Record a price move so the history chart and the change alerts stay consistent with
      // what a manual edit did, not just with what the bank feed observed.
      if (input.patch.amountMinor !== undefined && input.patch.amountMinor !== existing.amountMinor) {
        const from = money(existing.amountMinor, existing.currency);
        const to = money(updated.amountMinor, updated.currency);
        await ctx.db.insert(subscriptionPriceHistory).values({
          subscriptionId: updated.id,
          amountMinor: updated.amountMinor,
          currency: updated.currency,
          effectiveFrom: formatPlainDate(fromInstant(ctx.clock.now(), ctx.user.timezone ?? 'UTC')),
          deltaBps: from.currency === to.currency ? relativeChangeBps(from, to) : null,
          source: 'manual',
        });
      }

      await writeAudit(ctx, 'subscription.updated', updated.id, {
        before: { amountMinor: existing.amountMinor, status: existing.status },
        after: { amountMinor: updated.amountMinor, status: updated.status },
      });
      return updated;
    }),

  /** Archive, never delete. Brief §4.4 — a subscription is history, and history is not disposable. */
  archive: protectedProcedure
    .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(200), archived: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.scope.assertOwnsAll(subscriptions, input.ids);

      const updated = await ctx.db
        .update(subscriptions)
        .set({ archivedAt: input.archived ? ctx.clock.now() : null, updatedAt: new Date() })
        .where(ctx.scope.where(subscriptions, inArray(subscriptions.id, input.ids)))
        .returning({ id: subscriptions.id });

      await writeAudit(ctx, input.archived ? 'subscription.archived' : 'subscription.restored', null, {
        count: updated.length,
      });
      return { count: updated.length };
    }),

  /** Bulk categorize / tag — the operations a table with 47 rows actually needs. */
  bulkUpdate: protectedProcedure
    .input(
      z.object({
        ids: z.array(z.string().uuid()).min(1).max(200),
        category: z.enum(CATEGORIES).optional(),
        addTags: z.array(z.string().min(1).max(40)).max(20).optional(),
        removeTags: z.array(z.string()).max(20).optional(),
        paymentMethodId: z.string().uuid().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.scope.assertOwnsAll(subscriptions, input.ids);

      const tagExpression =
        input.addTags?.length || input.removeTags?.length
          ? sql`(
              select coalesce(array_agg(distinct t), '{}')
              from unnest(
                array_cat(${subscriptions.tags}, ${input.addTags ?? []}::text[])
              ) as t
              where t <> all(${input.removeTags ?? []}::text[])
            )`
          : undefined;

      const updated = await ctx.db
        .update(subscriptions)
        .set({
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.paymentMethodId === undefined ? {} : { paymentMethodId: input.paymentMethodId }),
          ...(tagExpression === undefined ? {} : { tags: tagExpression }),
          updatedAt: new Date(),
        })
        .where(ctx.scope.where(subscriptions, inArray(subscriptions.id, input.ids)))
        .returning({ id: subscriptions.id });

      await writeAudit(ctx, 'subscription.bulk_updated', null, { count: updated.length });
      return { count: updated.length };
    }),

  setShares: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        shares: z
          .array(
            z.object({
              personLabel: z.string().min(1).max(60),
              shareMinor: z.number().int().min(0),
              isSelf: z.boolean().default(false),
            }),
          )
          .max(20),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({ amountMinor: subscriptions.amountMinor })
        .from(subscriptions)
        .where(ctx.scope.whereId(subscriptions, input.id))
        .limit(1);

      if (existing === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That subscription does not exist.' });
      }

      const total = input.shares.reduce((sum, share) => sum + share.shareMinor, 0);
      if (input.shares.length > 0 && total !== existing.amountMinor) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Shares add up to ${String(total)} but the charge is ${String(existing.amountMinor)}. They have to match.`,
        });
      }
      if (input.shares.filter((share) => share.isSelf).length > 1) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only one share can be yours.' });
      }

      await ctx.db.transaction(async (tx) => {
        await tx.delete(subscriptionShares).where(eq(subscriptionShares.subscriptionId, input.id));
        if (input.shares.length > 0) {
          await tx
            .insert(subscriptionShares)
            .values(input.shares.map((share) => ({ ...share, subscriptionId: input.id })));
        }
      });

      await writeAudit(ctx, 'subscription.shares_updated', input.id, { count: input.shares.length });
      return { count: input.shares.length };
    }),

  logUsage: protectedProcedure
    .input(z.object({ id: z.string().uuid(), note: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.scope.assertOwnsAll(subscriptions, [input.id]);
      const [row] = await ctx.db
        .insert(usageLogs)
        .values({ subscriptionId: input.id, occurredAt: ctx.clock.now(), note: input.note ?? null })
        .returning();
      return row;
    }),
});

/**
 * Guards a status change through the state machine.
 *
 * The UI sends a target status, not a trigger, so this finds the user-initiated trigger that
 * permits the move. If none exists the move is refused — which is the point: "cancelled" going
 * straight back to "trialing" is not something a user meant to do.
 */
function assertStatusChange(from: SubscriptionStatus, to: SubscriptionStatus): void {
  const userTriggers: TransitionTrigger[] = [
    'user_edited',
    'user_paused',
    'user_resumed',
    'user_reactivated',
  ];

  for (const trigger of userTriggers) {
    try {
      transition(from, trigger, to);
      return;
    } catch {
      // Not this trigger; try the next. The throw below covers "none of them".
    }
  }

  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: `A subscription cannot go from ${from} to ${to}.`,
  });
}

interface AuditableContext {
  readonly db: Database;
  readonly scope: Scope;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

function writeAudit(
  ctx: AuditableContext,
  action: string,
  entityId: string | null,
  meta: Record<string, unknown>,
): Promise<void> {
  return recordAudit(
    ctx.db,
    ctx.scope,
    { ip: ctx.ip, userAgent: ctx.userAgent },
    action,
    'subscription',
    entityId,
    meta,
  );
}
