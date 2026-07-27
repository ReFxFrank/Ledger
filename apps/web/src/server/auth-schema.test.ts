import type { BetterAuthOptions } from 'better-auth';
import { getAuthTables } from 'better-auth/db';
import { twoFactor } from 'better-auth/plugins';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { accounts, passkeys, sessions, twoFactors, users, verifications } from '@ledger/db';

/**
 * Does our Drizzle schema actually satisfy better-auth?
 *
 * This test exists because it did not, twice, and neither failure was visible until a real
 * person tried to use the app:
 *
 *  - `user.two_factor_enabled` was missing. `protectedProcedure` gates on that exact field, so
 *    it read `undefined` — which is not `true` — and every protected procedure returned 403 for
 *    a fully enrolled user. Nothing threw.
 *  - `two_factor.verified`, `failed_verification_count`, and `locked_until` were missing.
 *    Enabling 2FA writes `verified`, so enrolment 500'd and the account could not be secured.
 *
 * Both were written from memory of better-auth's schema rather than from the installed version,
 * and a typecheck cannot catch that: the adapter resolves fields at runtime, by name.
 *
 * So this asks the library itself. `getAuthTables` returns the field set better-auth expects for
 * *our* exact plugin configuration, and we assert the Drizzle tables cover it. A version bump
 * that adds a column now fails here, in milliseconds, instead of in someone's browser.
 *
 * It deliberately checks only that we are not MISSING anything. Extra columns are ours to have —
 * `session.last_reauth_at` and the user's currency and timezone are app concerns the library has
 * no opinion about.
 */

/** Must mirror the plugin list and additionalFields in `server/auth.ts`. */
const AUTH_CONFIG: BetterAuthOptions = {
  plugins: [twoFactor({ issuer: 'Ledger' })],
  session: {
    additionalFields: {
      lastReauthAt: { type: 'date', required: false, input: false },
    },
  },
  user: {
    additionalFields: {
      displayCurrency: { type: 'string', defaultValue: 'USD', input: false },
      timezone: { type: 'string', defaultValue: 'UTC', input: false },
      locale: { type: 'string', defaultValue: 'en-US', input: false },
      onboardingCompletedAt: { type: 'date', required: false, input: false },
      deletedAt: { type: 'date', required: false, input: false },
    },
  },
};

/** better-auth model name → the Drizzle table registered for it in `drizzleAdapter`. */
const TABLE_FOR_MODEL: Record<string, PgTable> = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  twoFactor: twoFactors,
};

const expected = getAuthTables(AUTH_CONFIG);

describe('drizzle schema satisfies better-auth', () => {
  it('registers a table for every model better-auth expects', () => {
    expect(Object.keys(expected).sort()).toEqual(Object.keys(TABLE_FOR_MODEL).sort());
  });

  for (const [model, definition] of Object.entries(expected)) {
    describe(model, () => {
      const table = TABLE_FOR_MODEL[model];

      it('is registered', () => {
        expect(table, `no Drizzle table mapped for better-auth model "${model}"`).toBeDefined();
      });

      it('has every field better-auth will read or write', () => {
        if (table === undefined) return;
        const present = new Set(Object.keys(getTableColumns(table)));
        const missing = Object.keys(definition.fields).filter((field) => !present.has(field));

        expect(
          missing,
          `${getTableName(table)} is missing ${missing.join(', ')} — better-auth resolves these ` +
            'by name at runtime, so this is a 500 in production, not a type error.',
        ).toEqual([]);
      });

      it('has an id column', () => {
        if (table === undefined) return;
        expect(Object.keys(getTableColumns(table))).toContain('id');
      });
    });
  }
});

describe('app-owned fields better-auth must know about', () => {
  /**
   * A column better-auth has not been told about is written but never returned, which is a
   * uniquely nasty failure: the write succeeds, the read is silently `undefined`, and the
   * feature is simply dead. `session.lastReauthAt` shipped that way — every sensitive action
   * stayed blocked even straight after a correct password confirmation.
   */
  it('declares session.lastReauthAt so it comes back on the session object', () => {
    expect(Object.keys(expected['session']?.fields ?? {})).toContain('lastReauthAt');
  });

  it('declares the user fields the app reads off the session', () => {
    const fields = Object.keys(expected['user']?.fields ?? {});
    for (const field of ['twoFactorEnabled', 'displayCurrency', 'timezone', 'onboardingCompletedAt', 'deletedAt']) {
      expect(fields, `user.${field} would read as undefined without being declared`).toContain(field);
    }
  });
});

describe('tables the schema keeps deliberately', () => {
  /**
   * The passkey plugin is not registered — better-auth split it into `@better-auth/passkey` at
   * 1.6 and that package is not in the lockfile. The table stays anyway: dropping a table to
   * match a missing dependency is the wrong direction, and re-adding the plugin should be a
   * one-line change rather than a migration.
   */
  it('keeps the passkey table even though the plugin is not registered', () => {
    const columns = Object.keys(getTableColumns(passkeys));
    expect(columns).toContain('publicKey');
    expect(columns).toContain('credentialID');
    expect(Object.keys(expected)).not.toContain('passkey');
  });
});
