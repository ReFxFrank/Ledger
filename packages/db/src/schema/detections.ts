/**
 * Detection candidates — what the engine thinks might be a subscription, before a human agrees.
 *
 * A detection is never silently promoted into a subscription below 0.9 confidence, and never at
 * all unless the merchant is in the registry (brief §4.3). This table is the review queue.
 */

import { relations, sql } from 'drizzle-orm';
import {
  date,
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
import { users } from './auth';
import { merchants } from './merchants';
import { subscriptions } from './subscriptions';
import { billingChannelEnum, detectionStatusEnum, intervalUnitEnum } from './enums';

export const detections = pgTable(
  'detections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Clustering key from normalizeDescriptor(). Unique per user with the currency. */
    normalizedKey: text('normalized_key').notNull(),
    merchantId: uuid('merchant_id').references(() => merchants.id, { onDelete: 'set null' }),
    billingChannel: billingChannelEnum('billing_channel').notNull().default('direct'),

    intervalUnit: intervalUnitEnum('interval_unit').notNull(),
    intervalCount: integer('interval_count').notNull().default(1),

    /** Median, not mean — one annual charge among monthlies must not drag the figure. */
    medianAmountMinor: integer('median_amount_minor').notNull(),
    currency: text('currency').notNull(),
    /**
     * Coefficient of variation of the amounts. 0.05–0.40 means variable-but-regular (utilities,
     * cloud) and still gets surfaced, flagged; above 0.40 the engine discards it (brief §4.3).
     */
    amountCv: numeric('amount_cv', { precision: 6, scale: 4 }).notNull().default('0'),

    occurrences: integer('occurrences').notNull(),
    firstSeen: date('first_seen').notNull(),
    lastSeen: date('last_seen').notNull(),
    nextExpectedAt: date('next_expected_at'),

    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
    status: detectionStatusEnum('status').notNull().default('pending'),

    /**
     * Why the engine believes this: the contributing transaction ids, the day-gap sequence, the
     * matched alias, the confidence breakdown. Rendered in the review queue so a user can see
     * *why* a match was made and correct it in one click.
     */
    evidence: jsonb('evidence')
      .$type<{
        transactionIds: string[];
        gapDays: number[];
        matchedVia?: 'exact' | 'alias' | 'trigram' | 'none';
        matchScore?: number;
        confidenceFactors?: Record<string, number>;
        sampleDescriptors?: string[];
      }>()
      .notNull()
      .default(sql`'{"transactionIds":[],"gapDays":[]}'::jsonb`),

    /** Set when confirmed — the subscription this became. */
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    /** Why the user said no. Feeds back into not re-suggesting the same thing. */
    dismissedReason: text('dismissed_reason'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('detections_user_key_unique').on(table.userId, table.normalizedKey, table.currency),
    index('detections_user_status_idx').on(table.userId, table.status),
    index('detections_confidence_idx').on(table.confidence),
  ],
);

export const detectionsRelations = relations(detections, ({ one }) => ({
  user: one(users, { fields: [detections.userId], references: [users.id] }),
  merchant: one(merchants, { fields: [detections.merchantId], references: [merchants.id] }),
  subscription: one(subscriptions, {
    fields: [detections.subscriptionId],
    references: [subscriptions.id],
  }),
}));
