/**
 * Confidence scoring (brief §4.3).
 *
 * A detection engine that returns a bare number is a detection engine nobody can debug and no
 * user can argue with. So this module returns the number *and its derivation*: every input
 * contributes a named, signed amount, and those amounts sum to exactly the score. The review
 * queue renders that breakdown verbatim (§6.4), which means "why is this only 0.62?" has a
 * literal answer rather than an explanation someone has to reconstruct from the source.
 *
 * The caps are the important part and they come straight from the brief: two occurrences cap at
 * 0.5, three at 0.75, four or more are uncapped. Two charges a month apart are genuinely
 * ambiguous — a fortnight of rent and a fortnight of a gym look identical at n=2 — and no amount
 * of corroborating evidence should be able to talk the engine into auto-confirming them. The cap
 * is applied as an explicit negative factor rather than a silent `Math.min`, so a candidate held
 * back by evidence rather than by quality says so.
 */

import { type RecurrenceInterval, intervalsEqual } from '@ledger/core';

import type { MerchantMatch, MerchantRegistryEntry, SubscriptionCandidate } from './types';

// ── thresholds ─────────────────────────────────────────────────────────────────────────

/**
 * At or above this, and with a known merchant, a detection may be confirmed without asking.
 *
 * Both halves are required — see `canAutoConfirm`. A high score on an unknown merchant means the
 * *cadence* is certain, not the identity, and confirming a subscription we cannot name attaches
 * no cancellation playbook to it, which is the one thing brief §3.2 says never to get wrong.
 */
export const AUTO_CONFIRM_THRESHOLD = 0.9;

/** Below this a candidate is noise and is not worth a user's attention. */
export const SURFACE_THRESHOLD = 0.5;

// ── factor weights ─────────────────────────────────────────────────────────────────────

/**
 * How much each occurrence count is worth, indexed by count and flat from five onwards.
 *
 * Sub-linear on purpose: the jump from two charges to three is the difference between a
 * coincidence and a pattern, while the jump from eleven to twelve tells you nothing you did not
 * already know.
 */
const OCCURRENCE_WEIGHTS = [0, 0, 0.2, 0.3, 0.36, 0.4] as const;

const CADENCE_WEIGHT = 0.25;
const AMOUNT_WEIGHT = 0.15;
const REGISTRY_WEIGHT = 0.15;
/** A fuzzy name match is weaker evidence than an exact descriptor or a known alias. */
const REGISTRY_TRIGRAM_WEIGHT = 0.12;
/**
 * The registry saying "this merchant bills annually" and the data saying "annually" is the
 * single strongest corroboration available, because the two are independent.
 */
const TYPICAL_INTERVAL_WEIGHT = 0.2;
const MARKER_WEIGHT = 0.1;

const MISSED_PERIOD_PENALTY = 0.04;
const MISSED_PERIOD_PENALTY_CAP = 0.12;

/** The coefficient of variation at which amount stability is worth nothing at all. */
const AMOUNT_CV_CEILING = 0.4;

/**
 * The ceiling the occurrence count alone imposes, or no ceiling from four charges onwards.
 *
 * Infinity rather than 1 for the uncapped case on purpose: the 0..1 clamp is a separate,
 * separately-named adjustment, and a candidate held back by the *range* should not be reported
 * to the user as one held back by a shortage of evidence.
 */
function occurrenceCap(occurrences: number): number {
  if (occurrences >= 4) return Number.POSITIVE_INFINITY;
  if (occurrences === 3) return 0.75;
  // One occurrence only reaches here on the registry-asserted annual path (brief §4.4); it lands
  // on the surface threshold exactly, which is to say "shown, asked about, never assumed".
  return SURFACE_THRESHOLD;
}

// ── recurrence markers ─────────────────────────────────────────────────────────────────

/**
 * Words a bank or merchant puts in a descriptor when the charge is a standing arrangement.
 *
 * Tested against the **raw** descriptor, not the normalized key: normalization strips most of
 * these as trailing filler, which is correct for clustering and would throw away the signal
 * here. Non-English markers are included because the same subscription seen from a German or
 * French bank must not score lower for it.
 */
const RECURRENCE_MARKERS: readonly string[] = [
  'RECURRING',
  'RECURRENCE',
  'SUBSCRIPTION',
  'SUBSCR',
  'SUBS',
  'MONTHLY',
  'ANNUAL',
  'ANNUALLY',
  'YEARLY',
  'QUARTERLY',
  'WEEKLY',
  'AUTOPAY',
  'AUTO PAY',
  'AUTOMATIC PAYMENT',
  'STANDING ORDER',
  'DIRECT DEBIT',
  'MEMBERSHIP',
  'MEMBER',
  'RENEWAL',
  'RENEW',
  'DD',
  'ABONNEMENT',
  'ABO',
  'MONATLICH',
  'JAHRESABO',
  'MENSUEL',
  'MENSUAL',
  'PRENUMERATION',
  'DOORLOPENDE',
];

const MARKER_PATTERN = new RegExp(`\\b(?:${RECURRENCE_MARKERS.join('|')})\\b`);

/** True when any of `descriptors` advertises itself as a standing arrangement. */
export function hasRecurrenceMarker(descriptors: readonly string[]): boolean {
  return descriptors.some((descriptor) => MARKER_PATTERN.test(descriptor.toUpperCase()));
}

// ── scoring ────────────────────────────────────────────────────────────────────────────

export interface ConfidenceInput {
  readonly occurrences: number;
  /** From the cadence fit: 1 is every charge on its projected date. */
  readonly jitterScore: number;
  readonly missedPeriods: number;
  readonly amountCv: number;
  readonly merchantMatch: MerchantMatch;
  /** The matched merchant's registry entry, when there is one. */
  readonly registryEntry: MerchantRegistryEntry | null;
  readonly interval: RecurrenceInterval;
  readonly sampleDescriptors: readonly string[];
}

export interface ConfidenceScore {
  readonly score: number;
  /** Signed named contributions. Sums to `score`; the negative entries are why it is not higher. */
  readonly factors: Readonly<Record<string, number>>;
}

/**
 * Scores a candidate 0..1 and shows its working.
 *
 * The positive weights sum to more than 1 by design. A candidate that is strong on every axis is
 * supposed to saturate; what the weights encode is which evidence can *substitute* for which —
 * a long clean run of an unknown merchant and a short run of a known one both land in the
 * mid-0.8s, which is the trade the review queue is built to present.
 */
export function scoreConfidence(input: ConfidenceInput): ConfidenceScore {
  const factors: Record<string, number> = {};

  factors.occurrences =
    OCCURRENCE_WEIGHTS[Math.min(input.occurrences, OCCURRENCE_WEIGHTS.length - 1)] ??
    OCCURRENCE_WEIGHTS[OCCURRENCE_WEIGHTS.length - 1] ??
    0;

  factors.cadenceRegularity = CADENCE_WEIGHT * clamp01(input.jitterScore);

  // Linear from "fixed price" down to the variable-amount ceiling. Metered billing loses some of
  // this and is meant to: the cadence, not the amount, is what makes an AWS bill a subscription.
  factors.amountStability =
    AMOUNT_WEIGHT * (1 - Math.min(1, Math.max(0, input.amountCv) / AMOUNT_CV_CEILING));

  factors.merchantRegistry =
    input.merchantMatch.merchantId === null
      ? 0
      : input.merchantMatch.matchedVia === 'trigram'
        ? REGISTRY_TRIGRAM_WEIGHT
        : REGISTRY_WEIGHT;

  const typical = input.registryEntry?.typicalIntervals ?? [];
  factors.typicalInterval = typical.some((candidate) => intervalsEqual(candidate, input.interval))
    ? TYPICAL_INTERVAL_WEIGHT
    : 0;

  factors.recurrenceMarker = hasRecurrenceMarker(input.sampleDescriptors) ? MARKER_WEIGHT : 0;

  if (input.missedPeriods > 0) {
    factors.missedPeriods = -Math.min(
      MISSED_PERIOD_PENALTY_CAP,
      MISSED_PERIOD_PENALTY * input.missedPeriods,
    );
  }

  const raw = Object.values(factors).reduce((sum, value) => sum + value, 0);

  const cap = occurrenceCap(input.occurrences);
  if (raw > cap) factors.occurrenceCap = cap - raw;

  const capped = Math.min(raw, cap);
  const final = clamp01(capped);
  if (final !== capped) factors.clamp = final - capped;

  return { score: final, factors };
}

/**
 * Whether a candidate may be confirmed without the user looking at it.
 *
 * Two independent conditions, and the second is not redundant: the score measures how sure we
 * are that *something* recurs, the registry match measures whether we know *what*. Auto-
 * confirming an unidentified merchant creates a subscription with no cancellation route, which
 * is worse for the user than one more row in the review queue.
 */
export function canAutoConfirm(candidate: SubscriptionCandidate): boolean {
  return (
    candidate.confidence >= AUTO_CONFIRM_THRESHOLD && candidate.merchantMatch.merchantId !== null
  );
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
