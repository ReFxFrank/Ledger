import 'server-only';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { twoFactor } from 'better-auth/plugins';
import { accounts, getDatabase, sessions, twoFactors, users, verifications } from '@ledger/db';
import { loadServerEnv } from '@ledger/env';

/**
 * Authentication.
 *
 * TOTP is mandatory, not offered (brief §9.2). The plugin cannot express "required", so the
 * requirement is enforced one layer up: `requireVerifiedSession` in trpc/init.ts rejects any
 * session whose user has no `two_factor` row, and the app shell redirects to enrolment. That
 * keeps the rule in one place rather than trusting every route to remember it.
 *
 * TODO(frank): passkeys. better-auth moved the plugin out of core at 1.6 and into
 * `@better-auth/passkey`, which is not in this lockfile — registering it here is the whole fix,
 * and `src/lib/passkey.ts` already probes for it so the sign-in button lights up on its own.
 * The `passkeys` table in @ledger/db is unused until then; it is not dropped, because dropping a
 * table to match a missing dependency is the wrong direction.
 *
 * Built on first use rather than at module scope. `next build` imports every route module to
 * collect its config, and a module-scope `betterAuth(...)` made that import require the full
 * runtime environment — a live `DATABASE_URL`, and, because `next build` sets
 * `NODE_ENV=production`, the production-only secrets `loadServerEnv` insists on. Building is not
 * running: the environment is read on the first request instead, where a missing value is still
 * a hard failure.
 */
function createAuth() {
  const env = loadServerEnv();

  return betterAuth({
    appName: 'Ledger',
    baseURL: env.BETTER_AUTH_URL ?? env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,

    database: drizzleAdapter(getDatabase().db, {
      provider: 'pg',
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        twoFactor: twoFactors,
      },
    }),

    emailAndPassword: {
      enabled: true,
      // 12 is the floor because this account guards a map of the user's finances; the second
      // factor is mandatory anyway, but a weak password still widens the credential-stuffing window.
      minPasswordLength: 12,
      maxPasswordLength: 256,
      autoSignIn: false,
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 60 * 5 },
    },

    advanced: {
      cookiePrefix: 'ledger',
      useSecureCookies: env.NODE_ENV === 'production',
      defaultCookieAttributes: {
        sameSite: 'lax',
        httpOnly: true,
      },
    },

    user: {
      additionalFields: {
        displayCurrency: { type: 'string', defaultValue: 'USD', input: false },
        timezone: { type: 'string', defaultValue: 'UTC', input: false },
        locale: { type: 'string', defaultValue: 'en-US', input: false },
        // Declared so it survives the round trip into the session object. `me.current` reads it to
        // decide whether the user still owes us onboarding, and a column better-auth does not know
        // about comes back `undefined` — which reads as "never onboarded", forever.
        onboardingCompletedAt: { type: 'date', required: false, input: false },
        // Read by `enforceSession` in trpc/init.ts to refuse a session on an account whose
        // deletion has been requested. The cascade runs in a job, so between the request and the
        // job this column is the only thing that says the account is gone.
        deletedAt: { type: 'date', required: false, input: false },
      },
      deleteUser: { enabled: true },
    },

    plugins: [
      twoFactor({
        issuer: 'Ledger',
        totpOptions: { digits: 6, period: 30 },
        // Backup codes matter more than usual here: losing the authenticator locks the user out
        // of the only record they may have of what is charging their card.
        backupCodeOptions: { amount: 10, length: 10 },
      }),
      // Must stay last: it flushes Set-Cookie through the Next.js cookie API.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth['$Infer']['Session'];

/**
 * The process-wide instance. Memoised on `globalThis` for the same reason the database handle
 * is: a dev-mode module reload would otherwise build a second better-auth instance, and with it
 * a second connection pool, on every save.
 */
export function getAuth(): Auth {
  const cache = globalThis as typeof globalThis & { __ledgerAuth?: Auth };
  cache.__ledgerAuth ??= createAuth();
  return cache.__ledgerAuth;
}
