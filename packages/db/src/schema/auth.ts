/**
 * Auth tables.
 *
 * Column names and shapes are dictated by better-auth's Drizzle adapter and its `twoFactor` and
 * `passkey` plugins — renaming anything here silently breaks sign-in, so app-specific fields are
 * added as extra columns on `user` rather than by reshaping what the library owns.
 */

import { relations } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'user',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),

    /**
     * Owned by better-auth's `twoFactor` plugin, and the column the whole authorization model
     * turns on: `protectedProcedure` rejects any session where this is not `true`.
     *
     * It was missing from the first cut of this schema. Nothing failed loudly — the field simply
     * read `undefined`, which is not `true`, so every protected procedure returned 403 and the
     * app was unusable for a fully enrolled user. Declared here so the plugin can flip it and so
     * the check has something real to read.
     */
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),

    // ── app-owned columns ──────────────────────────────────────────────────────────────
    /** Everything on the dashboard is totalled in this currency (brief §4.4). */
    displayCurrency: text('display_currency').notNull().default('USD'),
    /** IANA zone. Renewals are wall-clock events, so this is not cosmetic. */
    timezone: text('timezone').notNull().default('UTC'),
    locale: text('locale').notNull().default('en-US'),
    onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
    /**
     * Set when a user asks for deletion. The cascade runs in a job, so this marks the account
     * as gone for every read path the moment the request is made rather than when the job lands.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('user_email_unique').on(table.email)],
);

export const sessions = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    /**
     * When this session last proved it was really the account holder — a fresh password or
     * passkey challenge. Brief §9.2 gates connecting a bank, exporting, deleting, and changing
     * 2FA behind a recent re-auth; this column is what "recent" is measured against.
     */
    lastReauthAt: timestamp('last_reauth_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('session_token_unique').on(table.token),
    index('session_user_idx').on(table.userId),
  ],
);

export const accounts = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('account_user_idx').on(table.userId),
    uniqueIndex('account_provider_unique').on(table.providerId, table.accountId),
  ],
);

export const verifications = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

/**
 * TOTP enrolment. Mandatory (brief §9.2) — a row here is what "finished onboarding" means, and
 * the app gates every authenticated route on its existence.
 */
export const twoFactors = pgTable(
  'two_factor',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('two_factor_user_idx').on(table.userId)],
);

export const passkeys = pgTable(
  'passkey',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialID: text('credential_i_d').notNull(),
    counter: integer('counter').notNull().default(0),
    deviceType: text('device_type'),
    backedUp: boolean('backed_up').notNull().default(false),
    transports: text('transports'),
    aaguid: text('aaguid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('passkey_user_idx').on(table.userId),
    uniqueIndex('passkey_credential_unique').on(table.credentialID),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  twoFactors: many(twoFactors),
  passkeys: many(passkeys),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));
