import 'server-only';

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  CATEGORIES,
  type Category,
  BILLING_CHANNELS,
  fromInstant,
  interval,
  nextOccurrenceAfter,
  parsePlainDate,
  toInstant,
} from '@ledger/core';
import {
  type Scope,
  type ScopedExecutor,
  type Transaction as DbTransaction,
  detections,
  merchants,
  subscriptionPriceHistory,
  subscriptions,
  transactions,
} from '@ledger/db';
import { recordAudit } from '~/server/audit';
import { protectedProcedure, router } from '~/server/trpc/init';

/**
 * The review queue (brief §7, /review).
 *
 * Nothing in here promotes a detection on its own. A detection is a claim the engine is making
 * about the user's bank feed, and the user is the one who decides whether it is true — which is
 * why `dismiss` records a reason instead of deleting the row, and why `bulkConfirm` refuses
 * anything the engine is not already confident enough to have auto-confirmed.
 */

/**
 * The auto-confirm bar, mirroring `canAutoConfirm` in @ledger/detection (brief §4.3).
 *
 * Restated here rather than imported because bulk confirmation is a *user* action taken over a
 * list they can see, not the engine acting unattended — but the bar is the same, and if these
 * two ever disagree the one a person sees in the UI is this one.
 */
const AUTO_CONFIRM_CONFIDENCE = 0.9;

const overridesInput = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    category: z.enum(CATEGORIES).optional(),
    amountMinor: z.number().int().optional(),
    intervalUnit: z.enum(['day', 'week', 'month', 'year']).optional(),
    intervalCount: z.number().int().min(1).max(365).optional(),
    billingChannel: z.enum(BILLING_CHANNELS).optional(),
    paymentMethodId: z.string().uuid().nullish(),
    /** A detection that is really a trial: the user knows, the bank feed does not. */
    status: z.enum(['active', 'trialing']).optional(),
    trialEndsAt: z.date().optional(),
    notes: z.string().max(4000).optional(),
    url: z.string().url().optional(),
  })
  .default({});

type Overrides = z.infer<typeof overridesInput>;

export const reviewRouter = router({
  /**
   * The queue itself.
   *
   * Ordered by confidence descending so the ones worth a glance come first and the marginal
   * ones sink. The evidence blob rides along untouched — the UI renders the transaction ids,
   * the gap sequence, and the confidence breakdown as the *reason*, and a review queue that
   * cannot show its reasoning is just a list of guesses.
   */
  list: protectedProcedure
    .input(
      z
        .object({
          status: z.enum(['pending', 'confirmed', 'dismissed', 'merged']).default('pending'),
          limit: z.number().int().min(1).max(200).default(50),
          cursor: z.number().int().min(0).default(0),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          detection: detections,
          merchantName: merchants.name,
          merchantSlug: merchants.slug,
          merchantLogo: merchants.logoUrl,
          merchantCategory: merchants.category,
        })
        .from(detections)
        .leftJoin(merchants, eq(detections.merchantId, merchants.id))
        .where(ctx.scope.where(detections, eq(detections.status, input.status)))
        .orderBy(desc(detections.confidence), desc(detections.occurrences))
        .limit(input.limit)
        .offset(input.cursor);

      return {
        items: rows.map((row) => ({
          ...row,
          // Precomputed so the bulk-confirm button can be enabled per row without the client
          // re-deriving a threshold it would inevitably get out of step with.
          canBulkConfirm: isBulkConfirmable(row.detection.confidence, row.detection.merchantId),
        })),
        nextCursor: rows.length === input.limit ? input.cursor + input.limit : null,
      };
    }),

  /**
   * The charges behind one detection.
   *
   * Read through `ctx.scope.transactions(...)` rather than trusted from the evidence blob: the
   * ids in there were written by the detection job, and a scoped read is what makes a corrupted
   * or stale evidence row a missing transaction instead of someone else's bank feed.
   */
  supportingTransactions: protectedProcedure
    .input(z.object({ detectionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const detection = await loadDetection(ctx.db, ctx.scope, input.detectionId);
      const ids = detection.evidence.transactionIds;
      if (ids.length === 0) return [];

      return ctx.db
        .select({
          id: transactions.id,
          postedAt: transactions.postedAt,
          amountMinor: transactions.amountMinor,
          currency: transactions.currency,
          rawDescriptor: transactions.rawDescriptor,
          normalizedKey: transactions.normalizedKey,
          billingChannel: transactions.billingChannel,
          pending: transactions.pending,
          subscriptionId: transactions.subscriptionId,
        })
        .from(transactions)
        .where(ctx.scope.transactions(inArray(transactions.id, ids)))
        .orderBy(desc(transactions.postedAt));
    }),

  /** Turns a detection into a real subscription. One transaction, so a half-confirmed row cannot exist. */
  confirm: protectedProcedure
    .input(z.object({ detectionId: z.string().uuid(), overrides: overridesInput }))
    .mutation(async ({ ctx, input }) => {
      const timezone = ctx.user.timezone ?? 'UTC';
      const now = ctx.clock.now();

      const created = await ctx.db.transaction(async (tx) => {
        const scope = ctx.scope.withExecutor(tx);
        const detection = await loadDetection(tx, scope, input.detectionId);
        assertPending(detection.status);
        return promote(tx, scope, detection, input.overrides, timezone, now);
      });

      await recordAudit(
        ctx.db,
        ctx.scope,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        'detection.confirmed',
        'detection',
        input.detectionId,
        { after: { subscriptionId: created.id, displayName: created.displayName } },
      );

      return created;
    }),

  /**
   * "Not a subscription."
   *
   * Sets a status and a reason; never deletes. The reason is what stops the engine re-surfacing
   * the same descriptor next week, and the row is what proves the user was asked.
   */
  dismiss: protectedProcedure
    .input(z.object({ detectionId: z.string().uuid(), reason: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(detections)
        .set({
          status: 'dismissed',
          dismissedReason: input.reason ?? null,
          resolvedAt: ctx.clock.now(),
          updatedAt: new Date(),
        })
        .where(ctx.scope.whereId(detections, input.detectionId, eq(detections.status, 'pending')))
        .returning({ id: detections.id });

      if (updated === undefined) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'That suggestion is not in the queue any more.',
        });
      }

      await recordAudit(
        ctx.db,
        ctx.scope,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        'detection.dismissed',
        'detection',
        input.detectionId,
        { reason: input.reason ?? null },
      );
      return { id: updated.id };
    }),

  /** "I already track this." Links the detection to the existing subscription and claims its charges. */
  merge: protectedProcedure
    .input(z.object({ detectionId: z.string().uuid(), subscriptionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const scope = ctx.scope.withExecutor(tx);
        const detection = await loadDetection(tx, scope, input.detectionId);
        assertPending(detection.status);
        await scope.assertOwnsAll(subscriptions, [input.subscriptionId]);

        await tx
          .update(detections)
          .set({
            status: 'merged',
            subscriptionId: input.subscriptionId,
            resolvedAt: ctx.clock.now(),
            updatedAt: new Date(),
          })
          .where(scope.whereId(detections, input.detectionId));

        await stampTransactions(tx, scope, detection.evidence.transactionIds, input.subscriptionId);
      });

      await recordAudit(
        ctx.db,
        ctx.scope,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        'detection.merged',
        'detection',
        input.detectionId,
        { after: { subscriptionId: input.subscriptionId } },
      );
      return { subscriptionId: input.subscriptionId };
    }),

  /**
   * Confirm a batch.
   *
   * Only detections the engine would have been allowed to auto-confirm are eligible: ≥0.9
   * confidence *and* a merchant in the registry. Everything else is returned as a skip with a
   * reason rather than quietly dropped, because "confirm all" that silently confirmed 6 of 11
   * is how a user ends up with a subscription list they no longer believe.
   */
  bulkConfirm: protectedProcedure
    .input(z.object({ detectionIds: z.array(z.string().uuid()).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const timezone = ctx.user.timezone ?? 'UTC';
      const now = ctx.clock.now();

      const rows = await ctx.db
        .select()
        .from(detections)
        .where(
          ctx.scope.where(
            detections,
            inArray(detections.id, input.detectionIds),
            eq(detections.status, 'pending'),
          ),
        );

      const found = new Set(rows.map((row) => row.id));
      const skipped = [
        ...input.detectionIds
          .filter((id) => !found.has(id))
          .map((id) => ({ id, reason: 'Already reviewed.' })),
        ...rows
          .filter((row) => !isBulkConfirmable(row.confidence, row.merchantId))
          .map((row) => ({
            id: row.id,
            reason:
              row.merchantId === null
                ? 'We do not recognise this merchant yet — confirm it individually.'
                : 'Not confident enough to confirm in bulk — confirm it individually.',
          })),
      ];

      const eligible = rows.filter((row) => isBulkConfirmable(row.confidence, row.merchantId));

      if (eligible.length === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `${skipReport(skipped.length)} Confirm them one at a time so you can check the evidence.`,
        });
      }

      const confirmed = await ctx.db.transaction(async (tx) => {
        const scope = ctx.scope.withExecutor(tx);
        const created: { detectionId: string; subscriptionId: string; displayName: string }[] = [];
        for (const detection of eligible) {
          const subscription = await promote(tx, scope, detection, {}, timezone, now);
          created.push({
            detectionId: detection.id,
            subscriptionId: subscription.id,
            displayName: subscription.displayName,
          });
        }
        return created;
      });

      await recordAudit(
        ctx.db,
        ctx.scope,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        'detection.bulk_confirmed',
        'detection',
        null,
        { count: confirmed.length, skipped: skipped.length },
      );

      return {
        confirmed,
        skipped,
        message:
          skipped.length === 0
            ? `Confirmed ${String(confirmed.length)}.`
            : `Confirmed ${String(confirmed.length)}. ${skipReport(skipped.length)}`,
      };
    }),
});

// ── internals ────────────────────────────────────────────────────────────────────────────

type DetectionRow = typeof detections.$inferSelect;

function skipReport(count: number): string {
  const subject = count === 1 ? '1 suggestion needs' : `${String(count)} suggestions need`;
  return `${subject} a closer look: either the confidence is below ${String(AUTO_CONFIRM_CONFIDENCE)} or we do not recognise the merchant.`;
}

/**
 * `confidence` is a Postgres `numeric`, which arrives as a string — the driver refuses to guess
 * a float for you, and that is the right call. Comparing it needs one explicit conversion, here.
 */
function isBulkConfirmable(confidence: string, merchantId: string | null): boolean {
  return merchantId !== null && Number(confidence) >= AUTO_CONFIRM_CONFIDENCE;
}

async function loadDetection(
  executor: ScopedExecutor,
  scope: Scope,
  id: string,
): Promise<DetectionRow> {
  const [row] = await executor
    .select()
    .from(detections)
    .where(scope.whereId(detections, id))
    .limit(1);

  if (row === undefined) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'That suggestion does not exist.' });
  }
  return row;
}

function assertPending(status: DetectionRow['status']): void {
  if (status !== 'pending') {
    throw new TRPCError({ code: 'CONFLICT', message: 'That suggestion has already been reviewed.' });
  }
}

/**
 * Detection → subscription, inside a caller-supplied transaction.
 *
 * The anchor is the detection's `firstSeen`, and the next renewal is projected from it with
 * `nextOccurrenceAfter` — never by adding 30 days to today. A detection that has been sitting
 * in the queue for a fortnight still knows exactly which day of the month it bills on, and
 * throwing that away at the moment of confirmation is how a renewal date starts drifting before
 * the subscription has even been saved once.
 */
async function promote(
  tx: DbTransaction,
  scope: Scope,
  detection: DetectionRow,
  overrides: Overrides,
  timezone: string,
  now: Date,
): Promise<typeof subscriptions.$inferSelect> {
  const merchant = await loadMerchant(tx, detection.merchantId);

  const unit = overrides.intervalUnit ?? detection.intervalUnit;
  const count = overrides.intervalCount ?? detection.intervalCount;
  const anchorDate = detection.firstSeen;
  const amountMinor = overrides.amountMinor ?? detection.medianAmountMinor;

  const anchor = parsePlainDate(anchorDate);
  const today = fromInstant(now, timezone);
  const nextRenewalAt = toInstant(
    nextOccurrenceAfter(anchor, interval(unit, count), today),
    timezone,
    9, // 09:00 local — a charge lands during the day, not at midnight.
  );

  const category: Category = overrides.category ?? merchant?.category ?? 'other';

  const [created] = await tx
    .insert(subscriptions)
    .values(
      scope.own({
        merchantId: detection.merchantId,
        displayName: overrides.displayName ?? merchant?.name ?? detection.normalizedKey,
        status: overrides.status ?? 'active',
        amountMinor,
        currency: detection.currency,
        intervalUnit: unit,
        intervalCount: count,
        anchorDate,
        nextRenewalAt,
        trialEndsAt: overrides.trialEndsAt ?? null,
        billingChannel: overrides.billingChannel ?? detection.billingChannel,
        paymentMethodId: overrides.paymentMethodId ?? null,
        category,
        source: 'detected',
        // Carried over verbatim, not reset to 1: the UI shows "detected, 94% confident" and a
        // laundered confidence would make every detected row look hand-entered.
        confidence: detection.confidence,
        // The engine only clusters amounts within a 0.40 coefficient of variation; above 0.05
        // it is regular-but-variable, and the user should see the amount as a median.
        variableAmount: Number(detection.amountCv) > 0.05,
        notes: overrides.notes ?? null,
        url: overrides.url ?? null,
      }),
    )
    .returning();

  if (created === undefined) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Could not save that.' });
  }

  // The first price point, dated from the anchor, so the history chart starts where the bank
  // feed says the charges started rather than on the day the user got round to confirming.
  await tx.insert(subscriptionPriceHistory).values({
    subscriptionId: created.id,
    amountMinor: created.amountMinor,
    currency: created.currency,
    effectiveFrom: anchorDate,
    deltaBps: null,
    source: 'detected',
  });

  await tx
    .update(detections)
    .set({
      status: 'confirmed',
      subscriptionId: created.id,
      resolvedAt: now,
      updatedAt: new Date(),
    })
    .where(scope.whereId(detections, detection.id));

  await stampTransactions(tx, scope, detection.evidence.transactionIds, created.id);

  return created;
}

async function loadMerchant(
  executor: ScopedExecutor,
  merchantId: string | null,
): Promise<{ name: string; category: Category } | null> {
  if (merchantId === null) return null;
  const [row] = await executor
    .select({ name: merchants.name, category: merchants.category })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);
  return row ?? null;
}

/**
 * Claims the charges behind a detection for a subscription.
 *
 * Scoped through `scope.transactions(...)` even though the ids came from our own evidence blob,
 * and restricted to rows not already claimed — a transaction that a different subscription has
 * already taken belongs to that one, and stealing it would silently corrupt both cadences.
 */
async function stampTransactions(
  tx: DbTransaction,
  scope: Scope,
  transactionIds: readonly string[],
  subscriptionId: string,
): Promise<void> {
  if (transactionIds.length === 0) return;

  await tx
    .update(transactions)
    .set({ subscriptionId })
    .where(
      scope.transactions(
        and(inArray(transactions.id, [...transactionIds]), isNull(transactions.subscriptionId)),
      ),
    );
}
