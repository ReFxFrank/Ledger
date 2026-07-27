import 'server-only';

import { TRPCError } from '@trpc/server';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { allCurrencies, isCurrencyCode } from '@ledger/core';
import { auditLog, sessions, users } from '@ledger/db';
import { recordAudit } from '../../audit';
import { getAuth } from '../../auth';
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
      /**
       * Which of the listed sessions is the one you are reading this on.
       *
       * The settings screen used better-auth's `useSession()` for this, and that hook is not
       * safe to render on the server — its React dispatcher is null during SSR, so /settings
       * threw and the error boundary showed "This screen failed to load". The fact is already
       * on the server; sending the id costs nothing and removes the hook entirely.
       *
       * The id, never the token: the token is the bearer credential and lives in an httpOnly
       * cookie precisely so that no script can read it.
       */
      currentSessionId: ctx.session?.session.id ?? null,
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

  /**
   * Re-authentication for sensitive actions (brief §9.2).
   *
   * `sensitiveProcedure` requires `session.last_reauth_at` inside a fifteen-minute window, and
   * until this existed nothing in the codebase ever wrote that column — which made every
   * sensitive action permanently unreachable, not merely gated. Connecting a bank, exporting
   * data, and deleting an account all failed with "confirm your password" and no way to do it.
   *
   * Uses better-auth's `verifyPassword` rather than a fresh sign-in on purpose: signing in again
   * would be intercepted by the two-factor plugin and rotate the session, so the user would be
   * asked for a TOTP code to perform an action they are already authenticated for.
   *
   * On `protectedProcedure`, not `sessionProcedure`. The circularity this was once written to
   * avoid — needing a re-auth in order to set up 2FA — does not exist: enrolment runs through
   * better-auth's own `twoFactor.enable({ password })`, which takes the password directly and
   * never touches this procedure. Everything that *does* consume the re-auth window is a
   * `sensitiveProcedure`, which is `protectedProcedure` plus the window, so a caller without a
   * second factor gained nothing here except the ability to probe a password behind a session.
   */
  reauthenticate: protectedProcedure
    .input(z.object({ password: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const sessionId = ctx.session?.session.id;
      if (sessionId === undefined) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to continue.' });
      }

      let valid = false;
      try {
        const result = await getAuth().api.verifyPassword({
          body: { password: input.password },
          headers: ctx.headers,
        });
        // better-auth returns `{ status: boolean }` here, not `{ valid }`. Read from the
        // installed types rather than from memory — that assumption has cost this codebase two
        // production-shaped bugs already.
        valid = result.status;
      } catch {
        // better-auth throws on a bad password rather than returning false. Either way this is
        // a wrong password, not an outage — never surface the internal error to the client.
        valid = false;
      }

      if (!valid) {
        await recordAudit(
          ctx.db,
          ctx.scope,
          { ip: ctx.ip, userAgent: ctx.userAgent },
          'account.reauth_failed',
          'account',
          ctx.user.id,
          {},
        );
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'That password is not correct.' });
      }

      const now = ctx.clock.now();
      await ctx.db
        .update(sessions)
        .set({ lastReauthAt: now, updatedAt: now })
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, ctx.user.id)));

      await recordAudit(
        ctx.db,
        ctx.scope,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        'account.reauthenticated',
        'account',
        ctx.user.id,
        {},
      );

      return { confirmedAt: now, validForMinutes: 15 };
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
