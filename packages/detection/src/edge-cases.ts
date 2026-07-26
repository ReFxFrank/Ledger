/**
 * The named edge cases from brief §4.4.
 *
 * These are the cases that separate a detector from a product. A grouping-and-cadence engine
 * finds Netflix; it also confidently reports that the user's £0.00 trial charge is a
 * subscription costing nothing, that a price rise is two different subscriptions, and that a
 * cancelled service simply vanished. Each function here exists because getting one of those
 * wrong is visible to the user in a way a missed cluster is not.
 *
 * Everything is a pure function of a cluster plus `today`. Nothing reads a clock — the trial and
 * lifecycle windows are the parts of detection most worth testing on a frozen date, and they can
 * only be tested that way if the date arrives as an argument.
 */

import {
  MONTHLY,
  type PlainDate,
  type RecurrenceInterval,
  type SubscriptionStatus,
  addInterval,
  approximateDays,
  daysBetween,
  isAfter,
  isCurrencyCode,
  money,
  relativeChangeBps,
} from '@ledger/core';

import type { AmountLevel, TransactionCluster } from './cluster';
import type {
  DuplicateGroup,
  MerchantRegistryEntry,
  PriceChange,
  SubscriptionCandidate,
} from './types';

// ── thresholds ─────────────────────────────────────────────────────────────────────────

/** Brief §4.4: a price move of 3% or more is a price change. Below it, billing noise. */
export const PRICE_CHANGE_MIN_BPS = 300;

/**
 * A first charge at or below this fraction of the eventual price is an introductory rate.
 *
 * Expressed as a divisor rather than a percentage because the comparison stays in integers:
 * `trial * TRIAL_PRICE_DIVISOR <= full`.
 */
export const TRIAL_PRICE_DIVISOR = 5;

/**
 * "Near zero" for a trial with nothing to compare against yet.
 *
 * One major unit in a two-decimal currency — the £1.00 or $0.50 card-verification charge that
 * almost every free trial posts. Currencies with a zero exponent (JPY, KRW) make this a
 * hundred-unit threshold rather than a one-unit one; that is wrong in principle and harmless in
 * practice, since the dominant signal for a pending trial is an exactly-zero amount.
 */
export const TRIAL_NEAR_ZERO_MINOR = 100;

/** Silence of this many periods demotes a candidate to paused… */
export const PAUSED_AFTER_PERIODS = 1.5;
/** …and this many to lapsed. Neither ever discards it (brief §4.4). */
export const LAPSED_AFTER_PERIODS = 2.5;

// ── price change ───────────────────────────────────────────────────────────────────────

/**
 * Basis-point change between two amounts.
 *
 * Routes through `@ledger/core`'s `relativeChangeBps` so the arithmetic is the same integer
 * bigint path the rest of the app uses. `DetectionTransaction.currency` is deliberately not
 * narrowed — bank feeds emit junk — so an unrecognised code falls back to a plain ratio rather
 * than throwing a currency error in the middle of a detection run.
 */
function changeBps(fromMinor: number, toMinor: number, currency: string): number | null {
  if (fromMinor === 0) return null;
  if (isCurrencyCode(currency)) {
    return relativeChangeBps(money(fromMinor, currency), money(toMinor, currency));
  }
  return Math.round(((toMinor - fromMinor) * 10_000) / fromMinor);
}

/**
 * Reports the most recent sustained price step, if there is one.
 *
 * The "sustained for one or more periods" requirement from the brief is already enforced
 * upstream: `cluster.ts` only commits a new level when two consecutive charges agree on it, so a
 * single odd amount that reverts never reaches here as a level at all. What is left to decide is
 * whether the step is *large* enough to tell the user about, and whether it is a price change at
 * all rather than a trial converting — a rise from zero has no percentage and belongs to
 * `detectTrial`.
 */
export function detectPriceChange(
  levels: readonly AmountLevel[],
  currency: string,
): PriceChange | null {
  const to = levels[levels.length - 1];
  const from = levels[levels.length - 2];
  if (to === undefined || from === undefined) return null;
  if (from.medianMinor === 0) return null;

  const deltaBps = changeBps(from.medianMinor, to.medianMinor, currency);
  if (deltaBps === null || Math.abs(deltaBps) < PRICE_CHANGE_MIN_BPS) return null;

  return {
    fromMinor: from.medianMinor,
    toMinor: to.medianMinor,
    deltaBps,
    // The date the new price first landed, not the date this ran. A user who opens the app in
    // March must be told the rise happened in January.
    effectiveFrom: to.firstSeen,
  };
}

// ── trials ─────────────────────────────────────────────────────────────────────────────

export interface TrialSignal {
  readonly isTrial: boolean;
  /**
   * When the trial converts (or converted). Null when nothing here looks like a trial.
   *
   * For a converted trial this is the date of the first full-price charge — a fact, not a
   * projection. For one that has not converted yet it is the trial charge plus the merchant's
   * typical billing interval, which is a guess, and the only reason it is worth making is that
   * the notification it drives ("your trial ends in 3 days") is the single most valuable alert
   * this product sends.
   */
  readonly trialEndsAt: PlainDate | null;
}

const NO_TRIAL: TrialSignal = { isTrial: false, trialEndsAt: null };

/**
 * Recognises the trial → paid transition, in both of its states.
 *
 * *Converted*: the cluster has a leading level that is zero or distinctly cheap — brief §4.4 puts
 * the line at a fifth of the eventual price — followed by a level at full price. The full-price
 * level's first charge is the conversion.
 *
 * *Pending*: a single near-zero charge and nothing after it. There is no second amount to
 * compare against, so the test is absolute rather than relative, and the conversion date is
 * projected from the merchant's typical interval (monthly when the registry has no opinion,
 * because a monthly plan is the overwhelming default and being a month early is a recoverable
 * error where being silent is not).
 */
export function detectTrial(
  cluster: TransactionCluster,
  registryEntry: MerchantRegistryEntry | null,
): TrialSignal {
  const first = cluster.levels[0];
  if (first === undefined) return NO_TRIAL;

  if (cluster.levels.length >= 2) {
    const next = cluster.levels[1];
    if (next === undefined) return NO_TRIAL;
    const introductory =
      first.medianMinor === 0 || first.medianMinor * TRIAL_PRICE_DIVISOR <= next.medianMinor;
    if (!introductory) return NO_TRIAL;
    // A trial is one cycle at the introductory rate, not a cheap first year. Several charges at
    // the low price is an intro *plan*, and that is a price change, not a trial.
    if (first.members.length > 1) return NO_TRIAL;
    return { isTrial: true, trialEndsAt: next.firstSeen };
  }

  if (cluster.charges.length !== 1) return NO_TRIAL;
  const charge = cluster.charges[0];
  if (charge === undefined) return NO_TRIAL;
  if (charge.transaction.amountMinor > TRIAL_NEAR_ZERO_MINOR) return NO_TRIAL;

  const interval = assumedTrialInterval(registryEntry);
  return { isTrial: true, trialEndsAt: addInterval(charge.transaction.postedAt, interval, 1) };
}

/**
 * The interval to bill a not-yet-converted trial at.
 *
 * Monthly when the registry has no opinion. A trial that converts to a monthly plan is the
 * overwhelming default, and the cost of the two errors is asymmetric: warning a user about a
 * renewal a month early is a mild annoyance, missing it entirely is the charge they wanted this
 * app to prevent.
 */
export function assumedTrialInterval(
  registryEntry: MerchantRegistryEntry | null,
): RecurrenceInterval {
  return registryEntry?.typicalIntervals[0] ?? MONTHLY;
}

// ── lifecycle ──────────────────────────────────────────────────────────────────────────

/**
 * Active, paused, or lapsed, from how long the charges have been silent.
 *
 * Measured in periods rather than days so the same rule works for a weekly newsletter and an
 * annual insurance premium. The period length is the nominal one — a ratio of elapsed days to
 * expected days, never a projected date — which is the one place in this package an approximate
 * month is the right tool.
 *
 * Nothing here discards. A subscription that stopped is the most interesting row in the app: it
 * is either a cancellation the user forgot they made, or a payment that failed.
 */
export function lifecycleFrom(
  lastSeen: PlainDate,
  interval: RecurrenceInterval,
  today: PlainDate,
): Extract<SubscriptionStatus, 'active' | 'paused' | 'lapsed'> {
  const elapsed = daysBetween(lastSeen, today) / approximateDays(interval);
  if (elapsed > LAPSED_AFTER_PERIODS) return 'lapsed';
  if (elapsed > PAUSED_AFTER_PERIODS) return 'paused';
  return 'active';
}

/** Folds the trial window into the lifecycle: a trial that has not converted is `trialing`. */
export function statusFor(
  trial: TrialSignal,
  lastSeen: PlainDate,
  interval: RecurrenceInterval,
  today: PlainDate,
): SubscriptionStatus {
  if (trial.isTrial && trial.trialEndsAt !== null && isAfter(trial.trialEndsAt, today)) {
    return 'trialing';
  }
  return lifecycleFrom(lastSeen, interval, today);
}

// ── annual from a single occurrence ────────────────────────────────────────────────────

/**
 * The interval to assume for a merchant seen exactly once, or null if we may not assume one.
 *
 * A single charge carries no cadence, so ordinarily it is not a candidate. The exception is the
 * one the brief calls out: when the registry says this merchant bills annually, one charge plus
 * that assertion is enough to *ask*. The user has a domain renewal or an insurance premium they
 * will otherwise not see again for eleven months, and surfacing it at low confidence costs one
 * review-queue row.
 *
 * Restricted to intervals of six months or more, and to non-fuzzy merchant matches (enforced by
 * the confidence floor at the call site), because the same logic applied to monthly merchants
 * would turn every one-off purchase from a known brand into a subscription.
 */
export function assumedLongInterval(
  registryEntry: MerchantRegistryEntry | null,
): RecurrenceInterval | null {
  const typical = registryEntry?.typicalIntervals ?? [];
  return (
    typical.find(
      (interval) => interval.unit === 'year' || (interval.unit === 'month' && interval.count >= 6),
    ) ?? null
  );
}

// ── duplicates across cards ────────────────────────────────────────────────────────────

/**
 * Links candidates that look like the same merchant billed on more than one account.
 *
 * Grouped by merchant id where there is one and by normalized key otherwise, so `SPOTIFY` on the
 * debit card and `PAYPAL *SPOTIFY` on the credit card land in the same group even though they
 * never shared a cluster. Currency is part of the group: the same merchant billed in two
 * currencies is a relocation, not a duplicate.
 *
 * Surfaced, never merged. A household really can pay for two Spotify plans, and silently
 * collapsing them would understate the user's spend — the failure mode this product cannot
 * afford. The note says what was observed, not what to do about it.
 */
export function findDuplicateGroups(
  candidates: readonly SubscriptionCandidate[],
): DuplicateGroup[] {
  const groups = new Map<string, SubscriptionCandidate[]>();
  for (const candidate of candidates) {
    const identity = candidate.merchantMatch.merchantId ?? `key:${candidate.normalizedKey}`;
    const key = `${identity}|${candidate.currency}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [candidate]);
    else bucket.push(candidate);
  }

  const duplicates: DuplicateGroup[] = [];
  for (const key of [...groups.keys()].sort()) {
    const members = groups.get(key) ?? [];
    if (members.length < 2) continue;

    const accounts = new Set(members.flatMap((candidate) => candidate.accountIds));
    // Two candidates on one account are two plans, or a naming variant we failed to merge.
    // Neither is the "same subscription on two cards" case this pass is looking for.
    if (accounts.size < 2) continue;

    const first = members[0];
    if (first === undefined) continue;
    duplicates.push({
      merchantId: first.merchantMatch.merchantId,
      normalizedKey: first.normalizedKey,
      candidateIds: members.map((candidate) => candidate.id).sort(),
      note:
        `${first.normalizedKey} bills on ${String(accounts.size)} accounts ` +
        `(${[...accounts].sort().join(', ')}). This may be two plans or a duplicate.`,
    });
  }
  return duplicates;
}
