/**
 * Subscriptions — the table the whole product is about.
 *
 * Money is `amount_minor` + `currency`, always. Cadence is `interval_unit` + `interval_count`,
 * never a day count, because calendar-monthly is not 30 days (brief §4.3). Dates that are
 * calendar facts (`anchor_date`, `cancel_by_at` day) are `date`; instants are `timestamptz`.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { paymentMethods } from './banking';
import { merchants } from './merchants';
import {
  billingChannelEnum,
  categoryEnum,
  intervalUnitEnum,
  subscriptionSourceEnum,
  subscriptionStatusEnum,
} from './enums';

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null for anything the registry does not know — manual entries stay first-class. */
    merchantId: uuid('merchant_id').references(() => merchants.id, { onDelete: 'set null' }),

    displayName: text('display_name').notNull(),
    status: subscriptionStatusEnum('status').notNull().default('active'),

    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),

    intervalUnit: intervalUnitEnum('interval_unit').notNull().default('month'),
    intervalCount: integer('interval_count').notNull().default(1),

    /**
     * The date the cadence is measured from. Every future renewal is `anchor + n × interval`,
     * computed from here rather than stepped forward from the last one — that is what keeps a
     * 31st-of-the-month subscription from drifting to the 28th after one February.
     */
    anchorDate: date('anchor_date').notNull(),
    nextRenewalAt: timestamp('next_renewal_at', { withTimezone: true }),
    lastChargedAt: timestamp('last_charged_at', { withTimezone: true }),

    /** Set while `status = 'trialing'`. The 3-day-before alert is scheduled against it. */
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),

    /** Who takes the money. Decides which cancellation playbook applies (brief §3.1). */
    billingChannel: billingChannelEnum('billing_channel').notNull().default('unknown'),
    paymentMethodId: uuid('payment_method_id').references(() => paymentMethods.id, {
      onDelete: 'set null',
    }),

    category: categoryEnum('category').notNull().default('other'),
    source: subscriptionSourceEnum('source').notNull().default('manual'),

    /** 0–1 from the detection engine. Manual entries are 1. */
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('1.000'),
    /** Utilities, cloud, anything usage-based. The amount shown is the median, not a promise. */
    variableAmount: boolean('variable_amount').notNull().default(false),
    autoRenew: boolean('auto_renew').notNull().default(true),

    /** next_renewal − notice_period. The date that actually matters when cancelling. */
    cancelByAt: timestamp('cancel_by_at', { withTimezone: true }),

    notes: text('notes'),
    url: text('url'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),

    /** Archived, not deleted. Brief §4.4: never auto-delete a subscription. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The Billing Horizon and the attention queue both read this ordering.
    index('subscriptions_user_renewal_idx').on(table.userId, table.nextRenewalAt),
    index('subscriptions_user_status_idx').on(table.userId, table.status),
    index('subscriptions_merchant_idx').on(table.merchantId),
    index('subscriptions_trial_idx').on(table.trialEndsAt),
    index('subscriptions_cancel_by_idx').on(table.cancelByAt),
  ],
);

/**
 * Every amount this subscription has ever charged.
 *
 * A row is written whenever the established amount moves by ≥3% (brief §4.4), which is what
 * makes "Spotify went from 9.99 to 12.99 — that's £36 a year" a fact rather than a guess.
 * `delta_bps` is basis points as an integer: a percentage stored as a float is the one place a
 * rounding artifact would surface directly in user-visible copy.
 */
export const subscriptionPriceHistory = pgTable(
  'subscription_price_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    /** Change from the previous row, in basis points. 9.99 → 12.99 is +3003. Null for the first. */
    deltaBps: integer('delta_bps'),
    /** `detected` | `manual` | `import`. */
    source: text('source').notNull().default('detected'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('price_history_subscription_idx').on(table.subscriptionId, table.effectiveFrom),
  ],
);

/**
 * Cost splitting. Brief decision #3: shares, not accounts.
 *
 * The person you split Netflix with does not need to sign up for anything, and "your cost" is
 * separated from "the charge" everywhere the two differ.
 */
export const subscriptionShares = pgTable(
  'subscription_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    personLabel: text('person_label').notNull(),
    /** This person's slice, in minor units of the subscription's currency. */
    shareMinor: integer('share_minor').notNull(),
    /** True for exactly one row: the user themselves. Drives "your cost". */
    isSelf: boolean('is_self').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('shares_subscription_idx').on(table.subscriptionId)],
);

/** Usage, so /analytics can answer "£17.99 a month, opened twice". */
export const usageLogs = pgTable(
  'usage_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    note: text('note'),
  },
  (table) => [index('usage_subscription_idx').on(table.subscriptionId, table.occurredAt)],
);

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  user: one(users, { fields: [subscriptions.userId], references: [users.id] }),
  merchant: one(merchants, { fields: [subscriptions.merchantId], references: [merchants.id] }),
  paymentMethod: one(paymentMethods, {
    fields: [subscriptions.paymentMethodId],
    references: [paymentMethods.id],
  }),
  priceHistory: many(subscriptionPriceHistory),
  shares: many(subscriptionShares),
  usage: many(usageLogs),
}));

export const subscriptionPriceHistoryRelations = relations(subscriptionPriceHistory, ({ one }) => ({
  subscription: one(subscriptions, {
    fields: [subscriptionPriceHistory.subscriptionId],
    references: [subscriptions.id],
  }),
}));

export const subscriptionSharesRelations = relations(subscriptionShares, ({ one }) => ({
  subscription: one(subscriptions, {
    fields: [subscriptionShares.subscriptionId],
    references: [subscriptions.id],
  }),
}));

export const usageLogsRelations = relations(usageLogs, ({ one }) => ({
  subscription: one(subscriptions, {
    fields: [usageLogs.subscriptionId],
    references: [subscriptions.id],
  }),
}));
