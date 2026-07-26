/**
 * Cancellation requests — the tracked, stateful workflow described in brief §3.
 *
 * The app never cancels anything itself. What it does is know the right exit, hold the deadline,
 * keep the evidence, chase the user, and then watch the bank feed to see whether the charge
 * actually stopped. That last step is why `verification_window_ends_at` and
 * `expected_next_charge_at` exist: verification is a scheduled fact-check, not a hope.
 */

import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { subscriptions } from './subscriptions';
import { transactions } from './transactions';
import {
  actorEnum,
  attachmentPurposeEnum,
  billingChannelEnum,
  cancellationMethodEnum,
  cancellationStatusEnum,
} from './enums';

export const cancellationRequests = pgTable(
  'cancellation_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Resolved from the playbook for this subscription's billing channel, not from the merchant. */
    method: cancellationMethodEnum('method').notNull(),
    channel: billingChannelEnum('channel').notNull().default('direct'),
    status: cancellationStatusEnum('status').notNull().default('draft'),

    /** A snapshot of the playbook steps with per-step completion. Snapshotted so a playbook
     *  update mid-flight does not renumber the steps under a user who is halfway through. */
    checklist: jsonb('checklist')
      .$type<{ id: string; text: string; detail?: string; warning?: string; doneAt?: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /** cancel-by = next renewal − notice period. The date that actually matters. */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),

    /** When the provider says it ends — often later than the cancellation itself. */
    effectiveAt: timestamp('effective_at', { withTimezone: true }),

    /**
     * The charge that should NOT appear. Verification watches for a charge near this date;
     * absence confirms the cancellation, presence escalates to `charged_after_cancellation`.
     */
    expectedNextChargeAt: timestamp('expected_next_charge_at', { withTimezone: true }),
    /** How long to keep watching. Charges post late; a 12-day tail is not an anomaly. */
    verificationWindowEndsAt: timestamp('verification_window_ends_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** Set when a charge landed anyway. This is the loud case. */
    chargedAfterCancellationTxId: uuid('charged_after_cancellation_tx_id').references(
      () => transactions.id,
      { onDelete: 'set null' },
    ),

    /** The reference number or confirmation code the provider gave. Evidence in a dispute. */
    confirmationReference: text('confirmation_reference'),
    refundExpectedMinor: integer('refund_expected_minor'),
    refundCurrency: text('refund_currency'),

    /** What they offered to keep the user, and whether it was taken. Accepting resets renewal. */
    retentionOffer: jsonb('retention_offer').$type<{
      describedAs: string;
      valueMinor?: number;
      currency?: string;
      offeredAt: string;
      accepted: boolean;
      resetsRenewalDate?: boolean;
    } | null>(),

    /** The letter/email body we generated, as sent. Kept verbatim for the record. */
    generatedLetter: text('generated_letter'),

    outcomeNotes: text('outcome_notes'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** Last time we chased. Stops the follow-up job nagging twice in a day. */
    lastNudgedAt: timestamp('last_nudged_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('cancellation_user_status_idx').on(table.userId, table.status),
    index('cancellation_subscription_idx').on(table.subscriptionId),
    index('cancellation_deadline_idx').on(table.deadlineAt),
    index('cancellation_verification_idx').on(table.verificationWindowEndsAt),
  ],
);

/** An append-only timeline. Never updated, never deleted — it is the audit trail for a dispute. */
export const cancellationEvents = pgTable(
  'cancellation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => cancellationRequests.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actor: actorEnum('actor').notNull().default('user'),
    /** `started` | `step_completed` | `letter_generated` | `evidence_added` | `status_changed` |
     *  `retention_offered` | `nudged` | `verified` | `charge_detected` */
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [index('cancellation_events_request_idx').on(table.requestId, table.at)],
);

/**
 * Uploaded evidence. Brief §3.1 step 6: this is what saves a user in a dispute.
 * Only the S3 key is stored; the bytes never pass through the database.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').references(() => cancellationRequests.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'cascade',
    }),
    s3Key: text('s3_key').notNull(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    purpose: attachmentPurposeEnum('purpose').notNull().default('other'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('attachments_user_idx').on(table.userId),
    index('attachments_request_idx').on(table.requestId),
  ],
);

export const cancellationRequestsRelations = relations(cancellationRequests, ({ one, many }) => ({
  subscription: one(subscriptions, {
    fields: [cancellationRequests.subscriptionId],
    references: [subscriptions.id],
  }),
  user: one(users, { fields: [cancellationRequests.userId], references: [users.id] }),
  events: many(cancellationEvents),
  attachments: many(attachments),
}));

export const cancellationEventsRelations = relations(cancellationEvents, ({ one }) => ({
  request: one(cancellationRequests, {
    fields: [cancellationEvents.requestId],
    references: [cancellationRequests.id],
  }),
}));

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  request: one(cancellationRequests, {
    fields: [attachments.requestId],
    references: [cancellationRequests.id],
  }),
  user: one(users, { fields: [attachments.userId], references: [users.id] }),
}));
