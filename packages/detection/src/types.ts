/**
 * The detection package's public contract.
 *
 * Everything here is plain data. `@ledger/detection` is pure: transactions in, candidates out,
 * no IO, no clock, no database (brief §4). That constraint is what makes a detection bug
 * reproducible from a JSON file, so it is worth the discipline of keeping every shape here
 * serialisable and free of classes.
 *
 * This file is the contract stage 2 (clustering, cadence, confidence) builds against. Adding a
 * field is cheap; changing the meaning of one is not.
 */

import type {
  BillingChannel,
  Category,
  PlainDate,
  RecurrenceInterval,
  SubscriptionStatus,
} from '@ledger/core';

// ── input ──────────────────────────────────────────────────────────────────────────────

/**
 * One posted card or bank transaction, reduced to the fields detection actually reads.
 *
 * Deliberately not the `transactions` row type: detection must not depend on `@ledger/db`, and
 * a narrower input means the fixture corpus can be written by hand.
 */
export interface DetectionTransaction {
  readonly id: string;
  readonly postedAt: PlainDate;
  /**
   * Integer minor units, **positive when money leaves the account**.
   *
   * Aggregators disagree about this sign (Plaid uses positive-for-outflow, most Open Banking
   * APIs use negative), so the adapter normalises it and detection gets one convention. A
   * negative amount here is a refund or a reversal, and the reversal pass pairs it with the
   * charge it undoes rather than treating it as a subscription.
   */
  readonly amountMinor: number;
  /** ISO-4217, uppercase. Not narrowed to `CurrencyCode` — bank feeds emit junk and the caller decides. */
  readonly currency: string;
  readonly rawDescriptor: string;
  readonly accountId: string;
  /**
   * Pending transactions get re-posted with a different id and often a different descriptor.
   * Counting both is the easiest way to invent a subscription that does not exist.
   */
  readonly pending: boolean;
}

// ── descriptor normalization (brief §4.2) ──────────────────────────────────────────────

/** Why a run of characters was removed from the descriptor. Drives the UI's dimming legend. */
export const STRIP_REASONS = [
  'processor',
  'channel',
  'phone',
  'url',
  'location',
  'date',
  'reference',
  'digits',
  'filler',
] as const;

export type StripReason = (typeof STRIP_REASONS)[number];

/** Half-open `[start, end)` range of character offsets into `NormalizedDescriptor.raw`. */
export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

export interface StrippedSpan extends TextSpan {
  readonly reason: StripReason;
}

/**
 * The result of normalising one bank descriptor.
 *
 * `strippedSpans` and `tokenSpans` exist for the "descriptor decoder" in brief §6.4: the UI dims
 * the noise the normaliser removed and highlights the substring that matched a merchant. Both
 * index into `raw`, so React renders the explanation instead of re-deriving it — and a
 * screenshot of the decoder is enough to debug a mis-normalisation.
 */
export interface NormalizedDescriptor {
  readonly raw: string;
  /**
   * The clustering key: uppercase, single-spaced, punctuation and noise removed.
   *
   * Empty when nothing identifying survived — a descriptor of pure reference numbers. Callers
   * discard those rather than clustering them together.
   */
  readonly normalized: string;
  /** Who takes the money (brief §3.1). Extracted from the descriptor, not guessed from the merchant. */
  readonly channel: BillingChannel;
  /** `normalized` split on whitespace. Same content, saved every caller a `.split()`. */
  readonly tokens: readonly string[];
  /**
   * Where each token came from in `raw`, index-aligned with `tokens`.
   *
   * When the key had to be synthesised from the billing-channel marker (an `APPLE.COM/BILL`
   * descriptor carries no merchant at all) this is the span of that marker, so the decoder still
   * has something honest to highlight.
   */
  readonly tokenSpans: readonly TextSpan[];
  readonly strippedSpans: readonly StrippedSpan[];
}

// ── merchant registry (data lives in @ledger/providers) ────────────────────────────────

export interface MerchantRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  /** Descriptor keys this merchant is known to bill under, in normalised form. */
  readonly descriptorPatterns: readonly string[];
  readonly typicalIntervals: readonly RecurrenceInterval[];
  readonly category: Category;
}

/**
 * Lookup surface only.
 *
 * The registry *data* ships in `@ledger/providers`, which depends on this package rather than
 * the other way round. Detection sees an interface it can satisfy from a fixture, which is why
 * the whole engine can be exercised without the provider dataset existing yet.
 */
export interface MerchantRegistry {
  /** O(1) hit on an exact normalised descriptor key. `null` when unknown — never throws. */
  byExactPattern(key: string): MerchantRegistryEntry | null;
  all(): readonly MerchantRegistryEntry[];
}

export const MATCH_METHODS = ['exact', 'alias', 'trigram', 'none'] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];

export interface MerchantMatch {
  readonly merchantId: string | null;
  readonly matchedVia: MatchMethod;
  /** 0..1. Exactly 0 when `matchedVia` is `'none'`; 1 for an exact pattern hit. */
  readonly score: number;
  /** Range in the raw descriptor the UI should highlight. Absent when nothing matched. */
  readonly matchedSpan?: TextSpan;
}

// ── output ─────────────────────────────────────────────────────────────────────────────

export interface PriceChange {
  readonly fromMinor: number;
  readonly toMinor: number;
  /** Signed, in basis points, relative to `fromMinor`. Integer arithmetic — see `relativeChangeBps`. */
  readonly deltaBps: number;
  /** The date of the first charge at the new price, not the date we noticed. */
  readonly effectiveFrom: PlainDate;
}

/**
 * A recurring charge series that looks like a subscription.
 *
 * A candidate is a *claim with its evidence attached*: `occurrences`, `gapDays`,
 * `confidenceFactors` and `sampleDescriptors` are all here so the review queue can explain why
 * this was surfaced. Brief §6.4 — a detection the user cannot audit is a detection they will
 * not trust.
 */
export interface SubscriptionCandidate {
  /** Stable within one `DetectionResult`; `DuplicateGroup.candidateIds` refers to it. */
  readonly id: string;
  readonly normalizedKey: string;
  readonly merchantMatch: MerchantMatch;
  readonly channel: BillingChannel;
  readonly interval: RecurrenceInterval;
  /** Median, not mean: one annual-plan charge in a monthly series must not drag the figure. */
  readonly medianAmountMinor: number;
  readonly currency: string;
  /** Coefficient of variation of the charge amounts. ~0 for a fixed price; high for metered billing. */
  readonly amountCv: number;
  readonly occurrences: number;
  readonly firstSeen: PlainDate;
  readonly lastSeen: PlainDate;
  /** `null` when the cadence is too irregular to project honestly. */
  readonly nextExpectedAt: PlainDate | null;
  /** 0..1. */
  readonly confidence: number;
  /**
   * Lifecycle at `DetectionOptions.today`, inferred from the charges alone.
   *
   * `paused` and `lapsed` are what silence means — brief §4.4 is explicit that a series that
   * stops is demoted and never discarded, and that demotion needs somewhere to live. `trialing`
   * means `trialEndsAt` is still in the future.
   */
  readonly status: SubscriptionStatus;
  /**
   * Every account these charges posted to, sorted.
   *
   * Usually one. Two means either a replaced card (the charges are sequential, so they stayed
   * one candidate) or a genuine duplicate, which the duplicate pass reads this field to find.
   */
  readonly accountIds: readonly string[];
  /** Metered or usage-based billing: the amount moves every cycle but the cadence holds. */
  readonly variableAmount: boolean;
  readonly isTrial: boolean;
  readonly trialEndsAt: PlainDate | null;
  readonly priceChange: PriceChange | null;
  /** In `postedAt` order, oldest first. */
  readonly transactionIds: readonly string[];
  /** Days between consecutive charges. `occurrences - 1` entries. The cadence evidence. */
  readonly gapDays: readonly number[];
  /** Named contributions to `confidence`, summing to it. Rendered verbatim in the review queue. */
  readonly confidenceFactors: Readonly<Record<string, number>>;
  /** A few raw descriptors from the cluster, for the decoder view. Not deduped away to one. */
  readonly sampleDescriptors: readonly string[];
}

/**
 * The same merchant billed on two or more distinct accounts.
 *
 * Not automatically a mistake — a household may genuinely pay for two Spotify plans — so this is
 * surfaced, never merged silently.
 */
export interface DuplicateGroup {
  readonly merchantId: string | null;
  readonly normalizedKey: string;
  readonly candidateIds: readonly string[];
  readonly note: string;
}

/** A charge undone by a later credit: a refund, a chargeback, or a mis-posted authorisation. */
export interface ReversalPair {
  readonly reversalId: string;
  readonly originalId: string;
}

export const DISCARD_REASONS = [
  'too_few_occurrences',
  'irregular_cadence',
  'amount_variance',
  'below_confidence',
  'unrecoverable_descriptor',
  'single_account_noise',
  'reversed',
] as const;

export type DiscardReason = (typeof DISCARD_REASONS)[number];

/** A cluster that was considered and rejected. Kept so "why is X missing?" has an answer. */
export interface DiscardedCluster {
  readonly normalizedKey: string;
  readonly reason: DiscardReason;
}

export interface DetectionResult {
  readonly candidates: readonly SubscriptionCandidate[];
  readonly duplicates: readonly DuplicateGroup[];
  readonly reversals: readonly ReversalPair[];
  readonly discarded: readonly DiscardedCluster[];
}

// ── options ────────────────────────────────────────────────────────────────────────────

export interface DetectionOptions {
  /**
   * The reference date. Passed in rather than read from a clock because this package is pure —
   * every projection and trial-window test in the suite runs against a fixed date.
   */
  readonly today: PlainDate;
  readonly registry?: MerchantRegistry;
  /** Candidates below this are moved to `discarded`. */
  readonly minConfidence?: number;
  /** Fewer charges than this cannot establish a cadence. */
  readonly minOccurrences?: number;
  /** Pending rows are excluded by default: they re-post under a new id and double-count. */
  readonly includePending?: boolean;
  /** Jaccard trigram similarity a fuzzy merchant match must clear. */
  readonly trigramThreshold?: number;
  /** Amount drift, in basis points, still considered "the same price" rather than a price change. */
  readonly amountToleranceBps?: number;
  /** How far a charge may land from its projected date and still count as on-cadence. */
  readonly dateToleranceDays?: number;
}

/**
 * Defaults, exported so tests and the review UI can state the thresholds they are describing
 * instead of hard-coding the same numbers a second time.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.5;
export const DEFAULT_MIN_OCCURRENCES = 2;
export const DEFAULT_TRIGRAM_THRESHOLD = 0.82;
export const DEFAULT_AMOUNT_TOLERANCE_BPS = 150;
export const DEFAULT_DATE_TOLERANCE_DAYS = 4;
