/**
 * Schema for the merchant dataset (`data/merchants/**\/*.yaml`).
 *
 * The dataset is hand-written, so this file — not code review — is where the product's
 * non-negotiable rules are enforced. Three of them matter more than the rest:
 *
 * 1. An App Store / Play / Roku / carrier subscription **cannot** be cancelled on the
 *    provider's website. A `cancelUrl` pointing there is the single most damaging thing this
 *    product can ship (brief §3.1), so those channels may only link at the store itself.
 * 2. A playbook with no `sourceUrl` / `lastVerifiedAt` is worse than no playbook, because the
 *    UI would present a guess with the same confidence as a fact. Both are required.
 * 3. No legal claims, anywhere, ever (docs/legal-notes.md). "You have the right to…" is a
 *    liability in some jurisdictions and false in others; the dataset states what the provider
 *    does, never what the user is entitled to.
 */

import {
  BILLING_CHANNELS,
  CANCELLATION_METHODS,
  CATEGORIES,
  isIntermediated,
  parsePlainDate,
  type BillingChannel,
  type IntervalUnit,
} from '@ledger/core';
import { z } from 'zod';

// ── normalization ──────────────────────────────────────────────────────────────────────

/**
 * The canonical form of a bank descriptor fragment. Detection normalizes an incoming
 * descriptor with its own (much heavier) pipeline and then looks the result up here, so both
 * sides have to agree on at least this much: uppercase, single-spaced, trimmed.
 */
export function normalizeDescriptorKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Aliases are human-typed brand names, so they fold to lowercase rather than up. */
export function normalizeAliasKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ── legal-claim guard (docs/legal-notes.md) ────────────────────────────────────────────

export const LEGAL_CLAIM_PATTERN =
  /\b(you have the right|legally required|the law (says|requires)|guaranteed? (refund|cancellation)|we (will )?cancel)\b/i;

/** Returns the offending phrase, or null. Exported so the Phase 7 copy review can reuse it. */
export function findLegalClaim(text: string): string | null {
  const match = LEGAL_CLAIM_PATTERN.exec(text);
  return match?.[0] ?? null;
}

/**
 * Free text that reaches a screen. Length caps are deliberate: a playbook step that needs 300
 * characters is two steps, and the workflow UI has nowhere to put an essay.
 */
function proseText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .superRefine((value, ctx) => {
      const claim = findLegalClaim(value);
      if (claim === null) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `legal claim ${JSON.stringify(claim)} — say what the provider does, not what the ` +
          `user is entitled to (docs/legal-notes.md)`,
      });
    });
}

// ── scalar schemas ─────────────────────────────────────────────────────────────────────

const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case, e.g. "disney-plus"')
  .max(64);

const domainSchema = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    'must be a bare lowercase hostname, e.g. "netflix.com" — no scheme, no path',
  )
  .max(253);

const descriptorPatternSchema = z
  .string()
  // Two characters would match half the dataset; the fragment has to identify a merchant.
  .min(3, 'descriptor fragments shorter than 3 characters match almost everything')
  .max(64)
  .refine(
    (value) => value === normalizeDescriptorKey(value),
    'must already be in normalized form: uppercase, single-spaced, trimmed',
  );

const httpsUrlSchema = z
  .string()
  .url()
  .max(500)
  .refine((value) => value.startsWith('https://'), 'must be an https URL');

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD (quote it in YAML)')
  .refine(isRealCalendarDate, 'is not a real calendar date');

function isRealCalendarDate(value: string): boolean {
  try {
    parsePlainDate(value);
    return true;
  } catch {
    // The only failure mode is "not a date"; the caller's message already says so.
    return false;
  }
}

/**
 * core exports `IntervalUnit` as a type but not as a tuple, and zod needs the literals.
 * `satisfies` catches a value here that core no longer knows about; a unit core adds later
 * simply fails validation loudly, which is the safe direction.
 */
const INTERVAL_UNITS = ['day', 'week', 'month', 'year'] as const satisfies readonly IntervalUnit[];

const typicalIntervalSchema = z
  .object({
    unit: z.enum(INTERVAL_UNITS),
    count: z.number().int().positive(),
  })
  .strict();

/** core's `CancellationDifficulty` is 1..5; literals keep the parsed value in that union. */
const difficultySchema = z.union(
  [z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)],
  {
    errorMap: () => ({
      message: 'must be a whole number from 1 (one click) to 5 (post/in person)',
    }),
  },
);

// ── the channel rule (brief §3.1 step 1) ───────────────────────────────────────────────

/**
 * Where an intermediated channel is allowed to send the user. Subdomains count, because the
 * real destinations are `apps.apple.com`, `account.microsoft.com`, `my.roku.com`.
 *
 * `carrier` is deliberately empty: which carrier bills the user is unknown at dataset-authoring
 * time, so no URL in a merchant file can be right for all of them.
 *
 * Non-US storefronts (amazon.co.uk, …) are not listed. The dataset is US-first; when it isn't,
 * this map grows rather than the rule loosening.
 */
const STORE_CANCEL_HOSTS: Readonly<Partial<Record<BillingChannel, readonly string[]>>> = {
  apple: ['apple.com'],
  google: ['play.google.com'],
  amazon: ['amazon.com'],
  roku: ['roku.com'],
  microsoft: ['microsoft.com'],
  carrier: [],
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    // Malformed URLs are already reported by the `url()` check on the field itself.
    return null;
  }
}

function isWithinHost(host: string, allowed: string): boolean {
  return host === allowed || host.endsWith(`.${allowed}`);
}

// ── playbook ───────────────────────────────────────────────────────────────────────────

const stepSchema = z
  .object({
    text: proseText(300),
    detail: proseText(1000).optional(),
    warning: proseText(300).optional(),
  })
  .strict();

const playbookObject = z
  .object({
    channel: z.enum(BILLING_CHANNELS),
    method: z.enum(CANCELLATION_METHODS),
    difficulty: difficultySchema,
    cancelUrl: httpsUrlSchema.optional(),
    steps: z.array(stepSchema).min(1, 'a playbook with no steps tells the user nothing'),
    // Vanity numbers ("1-800-FLOWERS") exist, so no format beyond "looks deliberate".
    phone: z.string().trim().min(5).max(40).optional(),
    hours: z.string().trim().min(1).max(120).optional(),
    noticePeriodDays: z.number().int().min(0).max(730).default(0),
    refundPolicy: proseText(1000).optional(),
    retentionOfferNotes: proseText(1000).optional(),
    gotchas: z.array(proseText(300)).default([]),
    letterTemplate: proseText(4000).optional(),
    evidenceHint: proseText(300).optional(),
    sourceUrl: httpsUrlSchema,
    lastVerifiedAt: isoDateSchema,
  })
  .strict();

type PlaybookShape = z.output<typeof playbookObject>;

export const playbookSchema = playbookObject.superRefine((playbook, ctx) => {
  checkStoreCancelUrl(playbook, ctx);
  checkMethodPrerequisites(playbook, ctx);

  if (playbook.difficulty >= 4 && playbook.gotchas.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gotchas'],
      message: 'difficulty 4+ needs at least one gotcha — if it is that hard, say why',
    });
  }
});

function checkStoreCancelUrl(playbook: PlaybookShape, ctx: z.RefinementCtx): void {
  const { channel, cancelUrl } = playbook;
  if (cancelUrl === undefined || !isIntermediated(channel)) return;

  const allowed = STORE_CANCEL_HOSTS[channel] ?? [];
  const host = hostOf(cancelUrl);
  if (host !== null && allowed.some((candidate) => isWithinHost(host, candidate))) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['cancelUrl'],
    message:
      allowed.length === 0
        ? `channel "${channel}" is billed by a third party that differs per user, so no ` +
          `cancelUrl can be right — drop it and let the steps say where to look`
        : `channel "${channel}" cancels inside the store's own settings: cancelUrl must be ` +
          `absent or on ${allowed.join(' / ')}, never the provider's own site (brief §3.1)`,
  });
}

function checkMethodPrerequisites(playbook: PlaybookShape, ctx: z.RefinementCtx): void {
  const { channel, method } = playbook;

  if (method === 'app_store' && !isIntermediated(channel)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['method'],
      message: `method "app_store" only makes sense on a store-billed channel, not "${channel}"`,
    });
  }

  if (method === 'phone' && playbook.phone === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['phone'],
      message: 'method "phone" requires a phone number',
    });
  }

  if (method === 'post' && playbook.letterTemplate === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['letterTemplate'],
      message: 'method "post" requires a letterTemplate — we will not ask a user to draft one',
    });
  }
}

export type Playbook = z.infer<typeof playbookSchema>;
export type PlaybookStep = z.infer<typeof stepSchema>;

// ── merchant file ──────────────────────────────────────────────────────────────────────

const merchantObject = z
  .object({
    slug: slugSchema,
    name: z.string().trim().min(1).max(120),
    legalName: z.string().trim().min(1).max(200).optional(),
    category: z.enum(CATEGORIES),
    domains: z.array(domainSchema).default([]),
    aliases: z.array(z.string().trim().min(2).max(80)).default([]),
    // A merchant with no descriptor fragment can never be matched to a transaction, which is
    // the only reason this dataset exists.
    descriptorPatterns: z
      .array(descriptorPatternSchema)
      .min(1, 'at least one descriptor fragment, or detection can never match this merchant'),
    typicalIntervals: z.array(typicalIntervalSchema).default([]),
    supersededBy: slugSchema.optional(),
    notes: proseText(2000).optional(),
    playbooks: z.array(playbookSchema).min(1, 'at least one playbook'),
  })
  .strict();

export const merchantFileSchema = merchantObject.superRefine((merchant, ctx) => {
  const seenChannels = new Map<string, number>();
  merchant.playbooks.forEach((playbook, index) => {
    const first = seenChannels.get(playbook.channel);
    if (first === undefined) {
      seenChannels.set(playbook.channel, index);
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['playbooks', index, 'channel'],
      message: `duplicate playbook for channel "${playbook.channel}" (already defined at index ${first})`,
    });
  });

  const seenPatterns = new Set<string>();
  merchant.descriptorPatterns.forEach((pattern, index) => {
    if (seenPatterns.has(pattern)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['descriptorPatterns', index],
        message: `duplicate descriptor fragment ${JSON.stringify(pattern)}`,
      });
    }
    seenPatterns.add(pattern);
  });

  if (merchant.supersededBy === merchant.slug) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['supersededBy'],
      message: 'a merchant cannot supersede itself',
    });
  }
});

export type MerchantFile = z.infer<typeof merchantFileSchema>;
