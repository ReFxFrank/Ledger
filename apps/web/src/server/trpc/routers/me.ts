import 'server-only';

import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { allCurrencies, isCurrencyCode } from '@ledger/core';
import { auditLog, users } from '@ledger/db';
import { recordAudit } from '../../audit';
import { protectedProcedure, router, sessionProcedure } from '../init';

export const meRouter = router({
  /**
   * The session bootstrap. Deliberately on `sessionProcedure` rather than `protectedProcedure`
   * so the app shell can read it *before* 2FA enrolment and know where to send the user.
   */
  current: sessionProcedure.query(({ ctx }) => {
    return {
      id: ctx.user.id,
      name: ctx.user.name,
      email: ctx.user.email,
      image: ctx.user.image ?? null,
      displayCurrency: ctx.user.displayCurrency ?? 'USD',
      timezone: ctx.user.timezone ?? 'UTC',
      locale: ctx.user.locale ?? 'en-US',
      twoFactorEnabled: ctx.user.twoFactorEnabled === true,
      onboardingCompletedAt: ctx.user.onboardingCompletedAt ?? null,
    };
  }),

  currencies: sessionProcedure.query(() => allCurrencies()),

  updatePreferences: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(120).optional(),
        displayCurrency: z
          .string()
          .length(3)
          .refine(isCurrencyCode, { message: 'Not a currency we know about.' })
          .optional(),
        // Validated against the runtime's own zone list rather than a hardcoded one, so it
        // stays correct as the IANA database changes.
        timezone: z
          .string()
          .refine(
            (value) => {
              try {
                new Intl.DateTimeFormat('en', { timeZone: value });
                return true;
              } catch {
                return false;
              }
            },
            { message: 'Not a recognised timezone.' },
          )
          .optional(),
        locale: z.string().max(20).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(users)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.displayCurrency === undefined
            ? {}
            : { displayCurrency: input.displayCurrency.toUpperCase() }),
          ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
          ...(input.locale === undefined ? {} : { locale: input.locale }),
          updatedAt: new Date(),
        })
        .where(eq(users.id, ctx.user.id))
        .returning();

      await recordAudit(
        ctx.db,
        ctx.scope,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        'account.preferences_updated',
        'account',
        ctx.user.id,
        { after: input },
      );

      return updated;
    }),

  completeOnboarding: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .update(users)
      .set({ onboardingCompletedAt: ctx.clock.now(), updatedAt: new Date() })
      .where(eq(users.id, ctx.user.id));
    return { ok: true };
  }),

  /** The audit log, shown in settings (brief §9.5). */
  activity: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50), cursor: z.number().int().min(0).default(0) }).default({}))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(auditLog)
        .where(ctx.scope.where(auditLog))
        .orderBy(desc(auditLog.at))
        .limit(input.limit)
        .offset(input.cursor);

      return { items: rows, nextCursor: rows.length === input.limit ? input.cursor + input.limit : null };
    }),
});
