/**
 * Audit log and households.
 *
 * The audit log is user-visible (brief §9.5) — settings shows it. That changes the design: it is
 * not a debug stream, it is a record a person reads to answer "what happened to my Spotify
 * subscription and who changed it". So `action` is a stable verb, and `meta` holds the before/
 * after rather than a serialized diff nobody can read.
 */

import { relations, sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { actorEnum } from './enums';

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actor: actorEnum('actor').notNull().default('user'),
    /** `subscription.created`, `connection.removed`, `cancellation.started`, `data.exported`… */
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    ip: text('ip'),
    ua: text('ua'),
    /** `{ before?, after?, reason? }`. Readable, because a human reads it. */
    meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_user_at_idx').on(table.userId, table.at.desc()),
    index('audit_entity_idx').on(table.entity, table.entityId),
  ],
);

/**
 * Households. Brief decision #3 defers real multi-user households in favour of
 * `subscription_shares`, but the tables exist so that turning it on later is a feature, not a
 * migration of everything. Nothing reads them in v1.
 *
 * TODO(frank): full household sharing needs an invite flow, a permission model, and a decision
 * about whether a member can see the payer's bank connections (they should not). Deferred rather
 * than half-built.
 */
export const households = pgTable('households', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const householdMembers = pgTable(
  'household_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    canSeeAmounts: boolean('can_see_amounts').notNull().default(true),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('household_members_household_idx').on(table.householdId)],
);

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  user: one(users, { fields: [auditLog.userId], references: [users.id] }),
}));

export const householdsRelations = relations(households, ({ many, one }) => ({
  members: many(householdMembers),
  owner: one(users, { fields: [households.ownerId], references: [users.id] }),
}));
