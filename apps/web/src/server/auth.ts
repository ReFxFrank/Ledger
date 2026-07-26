import 'server-only';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { passkey } from 'better-auth/plugins/passkey';
import { twoFactor } from 'better-auth/plugins';
import {
  accounts,
  getDatabase,
  passkeys,
  sessions,
  twoFactors,
  users,
  verifications,
} from '@ledger/db';
import { loadServerEnv } from '@ledger/env';

const env = loadServerEnv();

/**
 * Authentication.
 *
 * TOTP is mandatory, not offered (brief §9.2). The plugin cannot express "required", so the
 * requirement is enforced one layer up: `requireVerifiedSession` in trpc/init.ts rejects any
 * session whose user has no `two_factor` row, and the app shell redirects to enrolment. That
 * keeps the rule in one place rather than trusting every route to remember it.
 */
export const auth = betterAuth({
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
      passkey: passkeys,
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
    passkey({ rpName: 'Ledger' }),
    // Must stay last: it flushes Set-Cookie through the Next.js cookie API.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
export type Session = Auth['$Infer']['Session'];
