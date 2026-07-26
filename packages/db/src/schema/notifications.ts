/**
 * Notifications.
 *
 * `dedupe_key` is UNIQUE across the whole table and that single constraint is the mechanism
 * behind "a user must never be told the same thing twice" (brief §8). The scheduler is a
 * repeatable job that re-materializes rows on every run; without the constraint, a restart, a
 * clock skew, or two workers racing all produce a duplicate email. With it, the second insert
 * simply conflicts and is dropped.
 */

import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { subscriptions } from './subscriptions';
import { notificationChannelEnum, notificationTypeEnum } from './enums';

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    channel: notificationChannelEnum('channel').notNull(),

    /** Optional subject of the notification, so the UI can deep-link from the inbox. */
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'cascade',
    }),

    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    /** Set when quiet hours pushed this later. Kept so the UI can explain the delay. */
    deferredFrom: timestamp('deferred_from', { withTimezone: true }),

    /** e.g. `trial-ending:<subscriptionId>:2026-08-01`. Built by `dedupeKey()` in @ledger/core. */
    dedupeKey: text('dedupe_key').notNull(),

    /** Everything the template needs, frozen at schedule time. */
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),

    attempts: smallint('attempts').notNull().default(0),
    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('notifications_dedupe_unique').on(table.dedupeKey),
    // The sender's only query: everything due and not yet sent.
    index('notifications_pending_idx')
      .on(table.scheduledFor)
      .where(sql`${table.sentAt} is null`),
    index('notifications_user_idx').on(table.userId, table.createdAt.desc()),
  ],
);

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    /** Empty array = this type is off entirely. */
    channels: text('channels').array().notNull().default(sql`'{email,in_app}'::text[]`),
    /** How many days ahead. Trial conversion defaults to 3, consent expiry to 14. */
    leadTimeDays: integer('lead_time_days').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('notification_prefs_unique').on(table.userId, table.type)],
);

/**
 * Quiet hours and digest scheduling, one row per user.
 *
 * Stored as local minutes-from-midnight plus the user's timezone rather than as instants,
 * because "don't wake me before 8am" is a wall-clock statement that has to survive travel and DST.
 */
export const notificationSettings = pgTable('notification_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  quietHoursStartMinute: integer('quiet_hours_start_minute').notNull().default(1320), // 22:00
  quietHoursEndMinute: integer('quiet_hours_end_minute').notNull().default(480), // 08:00
  quietHoursEnabled: text('quiet_hours_enabled').notNull().default('true'),
  /** 0 = Sunday. Weekly digest, brief §8: Sunday 18:00 local, skipped when there is nothing to say. */
  digestDayOfWeek: smallint('digest_day_of_week').notNull().default(0),
  digestMinute: integer('digest_minute').notNull().default(1080), // 18:00
  /** Below this amount a renewal reminder is not worth an email. In the display currency. */
  renewalAlertThresholdMinor: integer('renewal_alert_threshold_minor').notNull().default(2000),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Web Push endpoints. One user can have several — phone, laptop, tablet. */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('push_endpoint_unique').on(table.endpoint),
    index('push_user_idx').on(table.userId),
  ],
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
  subscription: one(subscriptions, {
    fields: [notifications.subscriptionId],
    references: [subscriptions.id],
  }),
}));
