/**
 * The raw bank feed.
 *
 * This is the table that gets large — 50k rows per user is the load target — so the indexes are
 * chosen for the two queries that actually run: "this account, most recent first" and "everything
 * matching this normalised merchant key".
 *
 * `external_id` is unique because sync must be idempotent: running it twice produces zero
 * duplicates (Phase 5 acceptance). `dedupe_hash` catches the harder case — an aggregator that
 * re-issues a pending transaction under a new id when it posts.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bankAccounts } from './banking';
import { merchants } from './merchants';
import { subscriptions } from './subscriptions';
import { billingChannelEnum } from './enums';

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'cascade' }),
    /** The aggregator's id. Unique per provider — the primary idempotency key for sync. */
    externalId: text('external_id').notNull(),

    postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),

    /**
     * Positive = money leaving the account. The sign convention is normalised at the adapter
     * boundary because aggregators disagree about it, and a sign flip silently turns every
     * subscription into a refund.
     */
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),

    /** Exactly as the bank sent it. Never modified — it is the evidence for the decoder UI. */
    rawDescriptor: text('raw_descriptor').notNull(),
    /** Output of normalizeDescriptor(). The clustering key. */
    normalizedKey: text('normalized_key').notNull(),

    merchantId: uuid('merchant_id').references(() => merchants.id, { onDelete: 'set null' }),
    /** Extracted from the descriptor, not inferred later — `APPLE.COM/BILL` → `apple`. */
    billingChannel: billingChannelEnum('billing_channel').notNull().default('direct'),

    pending: boolean('pending').notNull().default(false),

    /** Set once a detection is confirmed, or when a charge is matched to a known subscription. */
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),

    /** FX rate to the user's display currency on the posting date. Null when they match. */
    fxRate: numeric('fx_rate', { precision: 20, scale: 10 }),

    /**
     * `sha256(accountId | postedAt | amountMinor | normalizedKey)`. Catches the pending →
     * posted re-issue, where the same charge arrives twice under different external ids.
     */
    dedupeHash: text('dedupe_hash').notNull(),

    /** Whatever else the aggregator sent, for debugging a bad match without a re-sync. */
    raw: jsonb('raw').default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('transactions_external_unique').on(table.externalId),
    uniqueIndex('transactions_dedupe_unique').on(table.accountId, table.dedupeHash),
    index('transactions_account_posted_idx').on(table.accountId, table.postedAt.desc()),
    index('transactions_normalized_idx').on(table.normalizedKey),
    index('transactions_subscription_idx').on(table.subscriptionId),
    index('transactions_merchant_idx').on(table.merchantId),
  ],
);

/**
 * A refund or chargeback, linked to the charge it reverses.
 *
 * Kept out of `transactions` as a link table so the cadence detector can exclude reversals
 * without needing to understand negative amounts (brief §4.4).
 */
export const transactionReversals = pgTable(
  'transaction_reversals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The negative-amount transaction. */
    reversalTransactionId: uuid('reversal_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    /** The original charge it cancels out. */
    originalTransactionId: uuid('original_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    /** `refund` | `chargeback` | `adjustment`. */
    kind: text('kind').notNull().default('refund'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reversal_unique').on(table.reversalTransactionId),
    index('reversal_original_idx').on(table.originalTransactionId),
  ],
);

export const transactionsRelations = relations(transactions, ({ one }) => ({
  account: one(bankAccounts, { fields: [transactions.accountId], references: [bankAccounts.id] }),
  merchant: one(merchants, { fields: [transactions.merchantId], references: [merchants.id] }),
  subscription: one(subscriptions, {
    fields: [transactions.subscriptionId],
    references: [subscriptions.id],
  }),
}));
