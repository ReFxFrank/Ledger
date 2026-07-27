import 'server-only';

import { TRPCError, initTRPC } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';
import { SystemClock, type Clock, isLedgerError } from '@ledger/core';
import { eq } from 'drizzle-orm';
import { type Database, Scope, getDatabase, sessions, users } from '@ledger/db';
import { childLogger } from '@ledger/logger';
import { type Auth, getAuth } from '../auth';

const log = childLogger('trpc');

export interface Context {
  readonly db: Database;
  readonly clock: Clock;
  readonly headers: Headers;
  readonly session: Awaited<ReturnType<Auth['api']['getSession']>>;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export async function createContext(opts: { headers: Headers }): Promise<Context> {
  const session = await getAuth().api.getSession({ headers: opts.headers });

  return {
    db: getDatabase().db,
    clock: new SystemClock(),
    headers: opts.headers,
    session,
    ip: opts.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: opts.headers.get('user-agent'),
  };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  /**
   * Errors cross this boundary into a browser, so the shape is deliberate: a stable `code` the
   * UI can switch on, zod's field errors for forms, and nothing else. A `LedgerError`'s `meta`
   * stays server-side — it is for logs, and it is the kind of place a token would eventually
   * end up if it were allowed through.
   */
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: cause instanceof ZodError ? cause.flatten() : null,
        ledgerCode: isLedgerError(cause) ? cause.code : null,
      },
    };
  },
});

export const createCallerFactory = t.createCallerFactory;
export const router = t.router;
export const mergeRouters = t.mergeRouters;

/** Logs slow calls. A tRPC procedure that takes a second is a query that needs an index. */
const timing = t.middleware(async ({ path, type, next }) => {
  const started = Date.now();
  const result = await next();
  const durationMs = Date.now() - started;
  if (durationMs > 500) log.warn({ path, type, durationMs }, 'slow procedure');
  return result;
});

export const publicProcedure = t.procedure.use(timing);

/**
 * An authenticated caller.
 *
 * Two things happen here that must never be optional:
 *
 *  1. **2FA is enforced.** A session that has not completed the second factor is not a session.
 *     better-auth exposes this as `twoFactorEnabled` on the user plus a pending-verification
 *     state; anything short of fully verified is rejected here rather than in each route.
 *  2. **A `Scope` is constructed.** Every procedure downstream reads user data through it, and
 *     there is no path to the database in this context that is not already bound to a user id.
 */
const enforceSession = t.middleware(async ({ ctx, next }) => {
  if (ctx.session?.session === undefined) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to continue.' });
  }

  const sessionUser = ctx.session.user;

  /**
   * Preferences come from the database, not from the session.
   *
   * Sessions are cached in a signed cookie for five minutes, and that snapshot includes the
   * user's timezone, display currency and locale. Twenty-four call sites read those to decide
   * which calendar day a renewal falls on, which bucket a transaction lands in, and what a
   * cancellation deadline is — so for five minutes after someone changed their timezone, every
   * one of them computed against the old one.
   *
   * The visible symptom was smaller and stranger: saving a timezone on /settings appeared to do
   * nothing, because the screen re-read `me.current`, which read the stale snapshot and handed
   * back the previous value. Same root cause as the `lastReauthAt` bug — mutable state read off
   * a cached session.
   *
   * One indexed primary-key lookup per authenticated call is the price, and correctness here is
   * worth more than it: these values decide what date the product tells someone their money
   * leaves.
   */
  const [profile] = await ctx.db
    .select({
      displayCurrency: users.displayCurrency,
      timezone: users.timezone,
      locale: users.locale,
      deletedAt: users.deletedAt,
      onboardingCompletedAt: users.onboardingCompletedAt,
    })
    .from(users)
    .where(eq(users.id, sessionUser.id))
    .limit(1);

  if (profile === undefined) {
    // The session is valid but the row is gone — a deletion that completed mid-request.
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to continue.' });
  }

  /**
   * A deletion request closes the account immediately, even though the cascade runs later in a
   * job. Checked here rather than per-route so there is no window in which a request that has
   * been made is still serving the data it was made about. Read from the row rather than the
   * session for the same staleness reason.
   */
  if (profile.deletedAt !== null) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'This account is closed.' });
  }

  const user = {
    ...sessionUser,
    displayCurrency: profile.displayCurrency,
    timezone: profile.timezone,
    locale: profile.locale,
    onboardingCompletedAt: profile.onboardingCompletedAt,
    deletedAt: profile.deletedAt,
  };

  return next({
    ctx: {
      ...ctx,
      user,
      session: ctx.session,
      scope: new Scope(ctx.db, user.id),
    },
  });
});

/**
 * The 2FA gate.
 *
 * Split from `enforceSession` because enrolment itself has to be reachable by a signed-in user
 * who does not yet have 2FA — that is the one authenticated surface allowed through without it.
 */
const enforceTwoFactor = t.middleware(({ ctx, next }) => {
  const user = ctx.session?.user;
  if (user === undefined) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to continue.' });
  }
  if (user.twoFactorEnabled !== true) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Set up two-factor authentication to continue.',
      cause: 'TWO_FACTOR_REQUIRED',
    });
  }
  return next();
});

/**
 * Re-authentication window for sensitive actions (brief §9.2): connecting a bank, exporting
 * everything, deleting the account, changing 2FA. Fifteen minutes is long enough not to be
 * infuriating and short enough that a walked-away-from laptop is not a full compromise.
 */
const REAUTH_WINDOW_MS = 15 * 60 * 1000;

const enforceRecentReauth = t.middleware(async ({ ctx, next }) => {
  const sessionId = ctx.session?.session.id;
  if (sessionId === undefined) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to continue.' });
  }

  /**
   * Read from the database, not from `ctx.session`.
   *
   * Sessions are cached in a signed cookie for five minutes, so the session object handed to
   * this middleware can be that stale — which meant a user who had *just* confirmed their
   * password was still refused, with no way to make progress except waiting out a TTL they
   * could not see. The freshness of a security gate should not depend on a cache expiring.
   *
   * The cost is one primary-key lookup, and only on sensitive actions, which are rare by
   * definition.
   */
  const [row] = await ctx.db
    .select({ lastReauthAt: sessions.lastReauthAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const last = row?.lastReauthAt;
  const lastMs = last === null || last === undefined ? 0 : last.getTime();

  if (ctx.clock.epochMillis() - lastMs > REAUTH_WINDOW_MS) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Confirm your password to continue.',
      cause: 'REAUTH_REQUIRED',
    });
  }
  return next();
});

/** Signed in, but 2FA may still be pending. Only enrolment and account basics use this. */
export const sessionProcedure = publicProcedure.use(enforceSession);

/** The default for everything that touches user data. */
export const protectedProcedure = sessionProcedure.use(enforceTwoFactor);

/** For irreversible or high-consequence actions. */
export const sensitiveProcedure = protectedProcedure.use(enforceRecentReauth);
