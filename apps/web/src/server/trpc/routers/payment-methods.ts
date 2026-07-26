import 'server-only';

import { eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { paymentMethods, subscriptions } from '@ledger/db';
import { recordAudit } from '~/server/audit';
import { protectedProcedure, router } from '~/server/trpc/init';

/**
 * Payment methods are labels, not instruments.
 *
 * The schema has no column a card number could live in, and this file is the other half of that
 * guarantee: the only card-shaped thing that gets past validation is four digits. Everything a
 * person might paste into a form — a PAN with spaces, with dashes, into the wrong field — is
 * refused with an explanation rather than truncated silently, because silently keeping the last
 * four of a number the user believed they were storing in full teaches them the wrong thing
 * about what this app holds.
 */
const CARD_NUMBER_MESSAGE =
  'Ledger never stores card numbers. Enter the brand and the last four digits only.';

/** 13–19 digits is the ISO/IEC 7812 PAN length range, after stripping the separators people type. */
function looksLikeCardNumber(value: string): boolean {
  return /^\d{13,19}$/.test(value.replace(/[\s-]/g, ''));
}

/** Applied to every free-text field, not just `last4` — a PAN pasted into `label` is still a PAN. */
function rejectCardNumber(value: string, ctx: z.RefinementCtx): void {
  if (looksLikeCardNumber(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: CARD_NUMBER_MESSAGE });
  }
}

const labelSchema = z.string().trim().min(1).max(80).superRefine(rejectCardNumber);

/** Short by design: "Visa", "Amex", "Mastercard". Long enough for "American Express". */
const brandSchema = z.string().trim().min(1).max(24).superRefine(rejectCardNumber);

const last4Schema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    if (looksLikeCardNumber(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: CARD_NUMBER_MESSAGE });
      return;
    }
    if (!/^\d{4}$/.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Last four digits only, as four digits.' });
    }
  });

const paymentMethodInput = z.object({
  label: labelSchema,
  type: z.enum(['card', 'bank_account', 'paypal', 'wallet', 'other']).default('card'),
  brand: brandSchema.nullish(),
  last4: last4Schema.nullish(),
  /** Expiry drives the "this card expires before the next renewal" warning, nothing else. */
  expMonth: z.number().int().min(1).max(12).nullish(),
  expYear: z.number().int().min(2000).max(2100).nullish(),
  bankAccountId: z.string().uuid().nullish(),
});

/** The columns any read returns. Listed explicitly so a future column cannot leak by default. */
const publicColumns = {
  id: paymentMethods.id,
  label: paymentMethods.label,
  type: paymentMethods.type,
  brand: paymentMethods.brand,
  last4: paymentMethods.last4,
  expMonth: paymentMethods.expMonth,
  expYear: paymentMethods.expYear,
  bankAccountId: paymentMethods.bankAccountId,
  archivedAt: paymentMethods.archivedAt,
  createdAt: paymentMethods.createdAt,
  updatedAt: paymentMethods.updatedAt,
} as const;

export const paymentMethodsRouter = router({
  list: protectedProcedure
    .input(z.object({ includeArchived: z.boolean().default(false) }).default({}))
    .query(async ({ ctx, input }) => {
      const [rows, counts] = await Promise.all([
        ctx.db
          .select(publicColumns)
          .from(paymentMethods)
          .where(
            ctx.scope.where(
              paymentMethods,
              input.includeArchived ? undefined : isNull(paymentMethods.archivedAt),
            ),
          )
          .orderBy(paymentMethods.label),

        // "You can't archive this — 4 subscriptions still charge to it" needs the number, and
        // the number is cheaper here than as a correlated subquery per row.
        ctx.db
          .select({
            paymentMethodId: subscriptions.paymentMethodId,
            count: sql<number>`count(*)::int`,
          })
          .from(subscriptions)
          .where(
            ctx.scope.where(
              subscriptions,
              isNull(subscriptions.archivedAt),
              isNotNull(subscriptions.paymentMethodId),
            ),
          )
          .groupBy(subscriptions.paymentMethodId),
      ]);

      const byMethod = new Map(counts.map((row) => [row.paymentMethodId, row.count]));
      return rows.map((row) => ({ ...row, subscriptionCount: byMethod.get(row.id) ?? 0 }));
    }),

  create: protectedProcedure.input(paymentMethodInput).mutation(async ({ ctx, input }) => {
    const [created] = await ctx.db
      .insert(paymentMethods)
      .values(
        ctx.scope.own({
          label: input.label,
          type: input.type,
          brand: input.brand ?? null,
          last4: input.last4 ?? null,
          expMonth: input.expMonth ?? null,
          expYear: input.expYear ?? null,
          bankAccountId: input.bankAccountId ?? null,
        }),
      )
      .returning(publicColumns);

    if (created === undefined) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Could not save that.' });
    }

    // `last4` is in the audit meta deliberately: it is the only way a person reading their own
    // activity log can tell which card an entry refers to, and four digits is not a secret.
    await recordAudit(
      ctx.db,
      ctx.scope,
      { ip: ctx.ip, userAgent: ctx.userAgent },
      'payment_method.created',
      'payment_method',
      created.id,
      { after: { label: created.label, brand: created.brand, last4: created.last4 } },
    );
    return created;
  }),

  update: protectedProcedure
    .input(z.object({ id: z.string().uuid(), patch: paymentMethodInput.partial() }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(paymentMethods)
        .set({
          ...(input.patch.label === undefined ? {} : { label: input.patch.label }),
          ...(input.patch.type === undefined ? {} : { type: input.patch.type }),
          ...(input.patch.brand === undefined ? {} : { brand: input.patch.brand ?? null }),
          ...(input.patch.last4 === undefined ? {} : { last4: input.patch.last4 ?? null }),
          ...(input.patch.expMonth === undefined ? {} : { expMonth: input.patch.expMonth ?? null }),
          ...(input.patch.expYear === undefined ? {} : { expYear: input.patch.expYear ?? null }),
          ...(input.patch.bankAccountId === undefined
            ? {}
            : { bankAccountId: input.patch.bankAccountId ?? null }),
          updatedAt: new Date(),
        })
        .where(ctx.scope.whereId(paymentMethods, input.id))
        .returning(publicColumns);

      if (updated === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That payment method does not exist.' });
      }

      await recordAudit(
        ctx.db,
        ctx.scope,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        'payment_method.updated',
        'payment_method',
        updated.id,
        { after: { label: updated.label, last4: updated.last4 } },
      );
      return updated;
    }),

  /**
   * Archive, never delete.
   *
   * A deleted payment method takes its `payment_method_id` off every subscription that pointed
   * at it (the FK is `set null`), which quietly erases "this used to charge to the old Amex" —
   * exactly the history someone reaches for when reconciling a charge they do not recognise.
   */
  archive: protectedProcedure
    .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(100), archived: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.scope.assertOwnsAll(paymentMethods, input.ids);

      const updated = await ctx.db
        .update(paymentMethods)
        .set({ archivedAt: input.archived ? ctx.clock.now() : null, updatedAt: new Date() })
        .where(ctx.scope.where(paymentMethods, inArray(paymentMethods.id, input.ids)))
        .returning({ id: paymentMethods.id });

      await recordAudit(
        ctx.db,
        ctx.scope,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        input.archived ? 'payment_method.archived' : 'payment_method.restored',
        'payment_method',
        input.ids.length === 1 ? (input.ids[0] ?? null) : null,
        { count: updated.length },
      );
      return { count: updated.length };
    }),

  /** What still charges to this method. The confirmation dialog before archiving reads it. */
  usage: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await ctx.scope.assertOwnsAll(paymentMethods, [input.id]);

      return ctx.db
        .select({
          id: subscriptions.id,
          displayName: subscriptions.displayName,
          amountMinor: subscriptions.amountMinor,
          currency: subscriptions.currency,
          status: subscriptions.status,
          nextRenewalAt: subscriptions.nextRenewalAt,
        })
        .from(subscriptions)
        .where(
          ctx.scope.where(
            subscriptions,
            eq(subscriptions.paymentMethodId, input.id),
            isNull(subscriptions.archivedAt),
          ),
        )
        .orderBy(subscriptions.displayName);
    }),
});
