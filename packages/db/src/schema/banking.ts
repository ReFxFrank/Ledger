/**
 * Payment methods and bank connections.
 *
 * Two rules this schema exists to enforce:
 *
 *  - **No card numbers, ever.** `payment_methods` holds a brand and a last-4 for labelling and
 *    nothing else. There is no column a PAN could be put in without a migration and a code review.
 *  - **No raw bank credentials.** `bank_connections.access_token_ciphertext` is an envelope from
 *    `@ledger/crypto`; `key_id` names the KEK that sealed it so rotation can run online.
 */

import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { connectionStatusEnum, paymentMethodTypeEnum } from './enums';

/**
 * A card or account the user pays with, as a label.
 *
 * `last4` and `brand` are here so the UI can say "the Amex ending 3007" — enough for a person to
 * know which card a charge lands on, and not enough to be worth stealing.
 */
export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    type: paymentMethodTypeEnum('type').notNull().default('card'),
    brand: text('brand'),
    /** Exactly four digits or null. Enforced by a check constraint in the migration. */
    last4: text('last4'),
    expMonth: integer('exp_month'),
    expYear: integer('exp_year'),
    /** Set when this method was derived from a linked bank account rather than typed in. */
    bankAccountId: uuid('bank_account_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('payment_methods_user_idx').on(table.userId)],
);

export const bankConnections = pgTable(
  'bank_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Which aggregator: `plaid`, `fixture`, later `truelayer` / `gocardless`. */
    provider: text('provider').notNull(),
    /** The aggregator's identifier for this link (Plaid's `item_id`). */
    externalItemId: text('external_item_id').notNull(),
    institutionId: text('institution_id'),
    institutionName: text('institution_name').notNull(),
    institutionLogo: text('institution_logo'),

    status: connectionStatusEnum('status').notNull().default('active'),

    /** Incremental sync cursor. Resuming from here is what makes a killed worker safe. */
    cursor: text('cursor'),

    /**
     * When the user's consent lapses. Open-banking consent expires on a fixed clock and the app
     * must warn *before* it breaks (brief §7, /connections), not after the first failed sync.
     */
    consentExpiresAt: timestamp('consent_expires_at', { withTimezone: true }),

    /** AES-256-GCM envelope. Opaque in a pg_dump. Never logged, never returned to the client. */
    accessTokenCiphertext: text('access_token_ciphertext').notNull(),
    /** Which KEK sealed it — lets `keys:rotate` work without downtime. */
    keyId: text('key_id').notNull(),

    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    /** Whether the initial 24-month backfill has finished. */
    backfillCompletedAt: timestamp('backfill_completed_at', { withTimezone: true }),
    /** Last failure, structured: `{ code, message, at, retryable }`. Cleared on success. */
    error: jsonb('error').$type<{
      code: string;
      message: string;
      at: string;
      retryable: boolean;
    } | null>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('bank_connections_user_idx').on(table.userId),
    uniqueIndex('bank_connections_item_unique').on(table.provider, table.externalItemId),
    index('bank_connections_consent_idx').on(table.consentExpiresAt),
  ],
);

export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => bankConnections.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    officialName: text('official_name'),
    /** Last few digits as the institution reports them. Display only. */
    mask: text('mask'),
    type: text('type').notNull().default('depository'),
    subtype: text('subtype'),
    currency: text('currency').notNull().default('USD'),
    /** Excluded accounts still sync but are ignored by detection — e.g. a business account. */
    excludedFromDetection: timestamp('excluded_from_detection', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('bank_accounts_connection_idx').on(table.connectionId),
    uniqueIndex('bank_accounts_external_unique').on(table.connectionId, table.externalId),
  ],
);

/**
 * Webhook deliveries we have already processed.
 *
 * Aggregators retry, and a replayed webhook that re-enqueues a sync is at best wasted work and
 * at worst a duplicate transaction. The unique index is the whole mechanism.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    /** Provider-supplied delivery id, or a hash of the body when they do not send one. */
    externalId: text('external_id').notNull(),
    itemId: text('item_id'),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('webhook_deliveries_unique').on(table.provider, table.externalId),
    index('webhook_deliveries_item_idx').on(table.itemId),
  ],
);

export const bankConnectionsRelations = relations(bankConnections, ({ one, many }) => ({
  user: one(users, { fields: [bankConnections.userId], references: [users.id] }),
  accounts: many(bankAccounts),
}));

export const bankAccountsRelations = relations(bankAccounts, ({ one }) => ({
  connection: one(bankConnections, {
    fields: [bankAccounts.connectionId],
    references: [bankConnections.id],
  }),
}));

export const paymentMethodsRelations = relations(paymentMethods, ({ one }) => ({
  user: one(users, { fields: [paymentMethods.userId], references: [users.id] }),
}));
