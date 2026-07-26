/**
 * The merchant registry and the cancellation playbooks.
 *
 * This is reference data, not user data: it is loaded from `packages/providers/data/**.yaml` at
 * migration time and refreshed by a job. It is also, per the brief, the real moat — so the
 * schema is built to make staleness visible (`last_verified_at`, `source_url`) rather than to
 * hide it.
 */

import { relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
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
import { billingChannelEnum, cancellationMethodEnum, categoryEnum, intervalUnitEnum } from './enums';

export const merchants = pgTable(
  'merchants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable, human-readable key. Also the URL segment for /guides/cancel/[merchant]. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    category: categoryEnum('category').notNull().default('other'),

    /** Domains the merchant bills from. Used to match email receipts and to build deep links. */
    domains: text('domains').array().notNull().default(sql`'{}'::text[]`),
    /** Alternative names people and banks use. Fed into the trigram matcher. */
    aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
    /**
     * Normalised descriptor fragments this merchant is known to produce, e.g. `NETFLIX.COM`.
     * Exact matches here short-circuit the fuzzy path entirely.
     */
    descriptorPatterns: text('descriptor_patterns').array().notNull().default(sql`'{}'::text[]`),

    logoUrl: text('logo_url'),
    /** Cadences this merchant actually sells. Lets a single annual charge be recognised. */
    typicalIntervals: jsonb('typical_intervals')
      .$type<{ unit: 'day' | 'week' | 'month' | 'year'; count: number }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /** Set when a merchant is renamed or absorbed. Old descriptors keep resolving. */
    supersededBy: uuid('superseded_by').references((): AnyPgColumn => merchants.id, {
      onDelete: 'set null',
    }),

    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('merchants_slug_unique').on(table.slug),
    index('merchants_category_idx').on(table.category),
    // Trigram index for the ≥0.82 similarity fallback in normalizeDescriptor (brief §4.2).
    index('merchants_name_trgm_idx').using('gin', sql`${table.name} gin_trgm_ops`),
    index('merchants_aliases_idx').using('gin', table.aliases),
    index('merchants_patterns_idx').using('gin', table.descriptorPatterns),
  ],
);

/**
 * How to actually get out — one row per (merchant, billing channel).
 *
 * The channel dimension is the whole point. Spotify billed directly and Spotify billed through
 * the App Store are different exits, and showing the wrong one wastes the user's afternoon and
 * their next renewal.
 */
export const cancellationPlaybooks = pgTable(
  'cancellation_playbooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    channel: billingChannelEnum('channel').notNull().default('direct'),
    method: cancellationMethodEnum('method').notNull(),
    /** 1–5, brief §3.2. Shown to the user unsoftened. */
    difficulty: smallint('difficulty').notNull().default(2),

    /** Deep link to the actual cancel page — never a homepage. */
    cancelUrl: text('cancel_url'),
    /** Ordered, provider-specific steps. `{ text, detail?, warning? }[]`. */
    steps: jsonb('steps')
      .$type<{ text: string; detail?: string; warning?: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    phone: text('phone'),
    hours: text('hours'),

    /** Days of notice the provider requires. Drives cancel_by_at = renewal − notice. */
    noticePeriodDays: integer('notice_period_days').notNull().default(0),
    refundPolicy: text('refund_policy'),
    /** "They will offer 3 months at 50% — accepting resets your renewal date." */
    retentionOfferNotes: text('retention_offer_notes'),
    /** The dark patterns, stated plainly. */
    gotchas: text('gotchas').array().notNull().default(sql`'{}'::text[]`),

    /** Handlebars-ish body for the generated letter. The user sends it, never the app. */
    letterTemplate: text('letter_template'),
    /** What to tell the user to keep as proof. */
    evidenceHint: text('evidence_hint'),

    /**
     * Where this was checked, and when. An unverified playbook is worse than none — it sends
     * someone to a page that has moved and costs them a renewal cycle.
     */
    sourceUrl: text('source_url'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('playbook_merchant_channel_unique').on(table.merchantId, table.channel),
    index('playbook_verified_idx').on(table.lastVerifiedAt),
  ],
);

/** Known plans, so a detected amount can be named ("Standard with ads") rather than guessed at. */
export const planCatalog = pgTable(
  'plan_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    intervalUnit: intervalUnitEnum('interval_unit').notNull().default('month'),
    intervalCount: integer('interval_count').notNull().default(1),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    /** Region the price applies to, ISO-3166 alpha-2. Prices differ per market. */
    region: text('region'),
    isTrial: boolean('is_trial').notNull().default(false),
    observedAt: timestamp('observed_at', { withTimezone: true }),
  },
  (table) => [index('plan_merchant_idx').on(table.merchantId)],
);

export const merchantsRelations = relations(merchants, ({ many, one }) => ({
  playbooks: many(cancellationPlaybooks),
  plans: many(planCatalog),
  successor: one(merchants, {
    fields: [merchants.supersededBy],
    references: [merchants.id],
    relationName: 'merchant_succession',
  }),
}));

export const cancellationPlaybooksRelations = relations(cancellationPlaybooks, ({ one }) => ({
  merchant: one(merchants, {
    fields: [cancellationPlaybooks.merchantId],
    references: [merchants.id],
  }),
}));

export const planCatalogRelations = relations(planCatalog, ({ one }) => ({
  merchant: one(merchants, { fields: [planCatalog.merchantId], references: [merchants.id] }),
}));
