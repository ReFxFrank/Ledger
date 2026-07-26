/**
 * Clustering (brief §4.3).
 *
 * Turns a flat transaction list into groups that plausibly share a billing relationship, and
 * resolves the three things that make a group untrustworthy before cadence ever sees it:
 * refunds that undo a charge, amounts that stepped to a new price, and amounts that never sit
 * still at all.
 *
 * The grouping key is `(normalizedKey, currency)`. Currency is in the key, not a detail: a €9.99
 * Spotify charge and a $9.99 one are two subscriptions, and a cluster that mixes them produces a
 * median that is not a price anybody was ever charged.
 *
 * Amounts are handled by *segmentation*, not by averaging. A subscription's price is a step
 * function — a trial, then a price, then a rise — and the useful question is never "what is the
 * mean" but "which step is it on now, and when did it move". Everything below is in service of
 * answering that with integer arithmetic.
 */

import { type PlainDate, comparePlainDate, daysBetween } from '@ledger/core';
import type { BillingChannel } from '@ledger/core';

import { normalizeDescriptor } from './normalize';
import type {
  DetectionTransaction,
  DiscardedCluster,
  NormalizedDescriptor,
  ReversalPair,
} from './types';

// ── thresholds ─────────────────────────────────────────────────────────────────────────

/**
 * The amount band, as basis points of the median plus an absolute floor.
 *
 * Brief §4.3: members within max(2%, 100 minor units) of the median. The floor is what keeps
 * cheap subscriptions clusterable — 2% of a £0.99 charge is two pence, and no billing system is
 * that consistent once tax and FX rounding are involved.
 */
export const AMOUNT_BAND_BPS = 200;
export const AMOUNT_BAND_FLOOR_MINOR = 100;

/** Coefficient of variation above which amounts are "variable" rather than fixed. */
export const CV_VARIABLE_MIN = 0.05;
/** …and above which they are not a subscription price at all. */
export const CV_VARIABLE_MAX = 0.4;

/** A new price has to hold for this many charges before it is a level rather than an oddity. */
const SUSTAINED_CHARGES = 2;

/**
 * Trial + old price + new price. Beyond that the amount is wandering rather than stepping, and
 * the segmentation is thrown away in favour of treating the cluster as variable-amount.
 */
const MAX_LEVELS = 3;

/**
 * Above this share of charges outside the band, the band is wrong — not the charges.
 *
 * This is the entire difference between "Netflix, with one odd month" and "an AWS bill". Both
 * look like a cluster full of mismatched amounts; only one of them has a price.
 */
const OUTLIER_MAX_SHARE = 0.25;

/**
 * How long after a charge a credit may still be its reversal.
 *
 * Card networks allow chargebacks well past a billing cycle, so this is deliberately longer than
 * a month; pairing is by exact amount, so the window can afford to be generous.
 */
export const REVERSAL_WINDOW_DAYS = 90;

/** Joins the two halves of a cluster key. Cannot appear in a normalized descriptor. */
const KEY_SEPARATOR = '|';

// ── shapes ─────────────────────────────────────────────────────────────────────────────

export interface ClusterMember {
  readonly transaction: DetectionTransaction;
  readonly descriptor: NormalizedDescriptor;
}

/** One price step: a contiguous run of charges that agree on an amount. */
export interface AmountLevel {
  readonly medianMinor: number;
  /** In `postedAt` order. Never empty. */
  readonly members: readonly ClusterMember[];
  readonly firstSeen: PlainDate;
}

export interface TransactionCluster {
  readonly normalizedKey: string;
  readonly currency: string;
  readonly channel: BillingChannel;
  /**
   * `'all'` when the cluster spans every account it was found on, otherwise the single account
   * it was split onto. Part of the candidate id, so a split is stable across runs.
   */
  readonly accountScope: string;
  readonly accountIds: readonly string[];
  /** Charges that count, in `postedAt` order: the concatenation of `levels`. */
  readonly charges: readonly ClusterMember[];
  /** Oldest first. `levels[levels.length - 1]` is the price in force now. */
  readonly levels: readonly AmountLevel[];
  /** One-off amounts that neither held nor reverted to. Excluded from cadence and from stats. */
  readonly outliers: readonly ClusterMember[];
  /** Median of the *current* level — the price the user is paying, not an average of history. */
  readonly medianAmountMinor: number;
  /** Coefficient of variation within the current level. */
  readonly amountCv: number;
  readonly variableAmount: boolean;
  readonly discardReason: DiscardedCluster['reason'] | null;
}

export interface ClusterOptions {
  readonly includePending?: boolean | undefined;
  readonly amountToleranceBps?: number | undefined;
}

export interface ClusterOutcome {
  readonly clusters: readonly TransactionCluster[];
  readonly reversals: readonly ReversalPair[];
  readonly discarded: readonly DiscardedCluster[];
}

// ── integer statistics ─────────────────────────────────────────────────────────────────

/**
 * Median of integer minor units, staying in integer space.
 *
 * An even-length median is the floor of the midpoint of the two middle values, not their exact
 * average: prices are integers, and £11.495 is not a price. Rounding *down* rather than to
 * nearest is the conservative direction — it never invents a subscription that costs more than
 * the charges show, which matters because this figure feeds the committed-spend total.
 */
export function integerMedian(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  const low = sorted[middle - 1] ?? 0;
  const high = sorted[middle] ?? 0;
  return Math.floor((low + high) / 2);
}

/**
 * Standard deviation over the mean.
 *
 * The one float in this file, and deliberately so: a coefficient of variation is a dimensionless
 * ratio, not a monetary value. Brief §11 bans floats from money, not from statistics about it.
 */
export function coefficientOfVariation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

/** Half-width of the "same price" band around `median`, in minor units. */
export function amountBand(medianMinor: number, bps: number): number {
  const relative = Math.ceil((Math.abs(medianMinor) * bps) / 10_000);
  return Math.max(relative, AMOUNT_BAND_FLOOR_MINOR);
}

function withinBand(value: number, medianMinor: number, bps: number): boolean {
  return Math.abs(value - medianMinor) <= amountBand(medianMinor, bps);
}

// ── level segmentation ─────────────────────────────────────────────────────────────────

interface Segmentation {
  readonly levels: readonly (readonly ClusterMember[])[];
  readonly outliers: readonly ClusterMember[];
}

/**
 * Splits charges into price steps, in one forward pass with one charge of lookahead.
 *
 * The lookahead is the whole rule, and it is what brief §4.4 asks for in both directions: a
 * charge that disagrees with the current level only *starts* a new level if the charge after it
 * agrees with it. One odd amount that reverts is an outlier; two in a row is a price change. A
 * disagreeing charge in the final position can never be confirmed, so it is an outlier too —
 * conservative on purpose, because announcing a price rise that turns out to be a one-off refund
 * adjustment is worse than announcing it a cycle late.
 */
function segmentLevels(charges: readonly ClusterMember[], bps: number): Segmentation {
  const levels: ClusterMember[][] = [];
  const outliers: ClusterMember[] = [];
  let current: ClusterMember[] = [];

  for (let i = 0; i < charges.length; i += 1) {
    const member = charges[i];
    if (member === undefined) continue;
    const amount = member.transaction.amountMinor;

    if (current.length === 0) {
      current.push(member);
      continue;
    }

    const median = integerMedian(current.map((m) => m.transaction.amountMinor));
    if (withinBand(amount, median, bps)) {
      current.push(member);
      continue;
    }

    const next = charges[i + 1];
    const sustained = next !== undefined && withinBand(next.transaction.amountMinor, amount, bps);
    if (sustained) {
      levels.push(current);
      current = [member];
    } else {
      outliers.push(member);
    }
  }
  if (current.length > 0) levels.push(current);

  return { levels, outliers };
}

/**
 * Applies the two sanity checks that turn a segmentation into a decision.
 *
 * Too many outliers or too many levels both mean the same thing — the amount does not have a
 * fixed value to be measured against — and the answer in both cases is to stop trying to find
 * one and let the coefficient of variation speak instead.
 */
function resolveLevels(charges: readonly ClusterMember[], bps: number): Segmentation {
  const attempt = segmentLevels(charges, bps);
  const outlierShare = charges.length === 0 ? 0 : attempt.outliers.length / charges.length;
  if (outlierShare > OUTLIER_MAX_SHARE || attempt.levels.length > MAX_LEVELS) {
    return { levels: charges.length === 0 ? [] : [charges], outliers: [] };
  }
  return attempt;
}

// ── reversals ──────────────────────────────────────────────────────────────────────────

interface ReversalOutcome {
  readonly charges: readonly ClusterMember[];
  readonly pairs: readonly ReversalPair[];
}

/**
 * Pairs credits with the charges they undo, and removes both.
 *
 * The credit is obviously not a subscription payment. The charge it reverses is dropped too,
 * which is the less obvious half: a charge that was refunded in full cost the user nothing and
 * is not evidence that the subscription was live that month. Dropping it leaves a hole in the
 * cadence, and the single-missed-period rule is exactly what absorbs that hole — so a genuine
 * subscription with one refunded month still detects, while a mis-posted authorisation and its
 * reversal cancel out completely instead of inventing a two-occurrence series.
 *
 * Matching is by exact magnitude within `REVERSAL_WINDOW_DAYS`, most recent charge first, each
 * charge claimable once. Partial refunds are deliberately not matched: a partial credit is a
 * price adjustment, and the amount segmentation is a better place to notice it.
 */
function linkReversals(members: readonly ClusterMember[]): ReversalOutcome {
  // `>= 0`, not `> 0`: a zero-amount row is the free-trial charge, and dropping it here is how
  // you build an engine that cannot see a trial at all.
  const charges = members.filter((m) => m.transaction.amountMinor >= 0);
  const credits = members.filter((m) => m.transaction.amountMinor < 0);
  if (credits.length === 0) return { charges, pairs: [] };

  const claimed = new Set<string>();
  const pairs: ReversalPair[] = [];

  for (const credit of credits) {
    const magnitude = -credit.transaction.amountMinor;
    for (let i = charges.length - 1; i >= 0; i -= 1) {
      const charge = charges[i];
      if (charge === undefined) continue;
      if (claimed.has(charge.transaction.id)) continue;
      if (charge.transaction.amountMinor !== magnitude) continue;
      const age = daysBetween(charge.transaction.postedAt, credit.transaction.postedAt);
      if (age < 0 || age > REVERSAL_WINDOW_DAYS) continue;
      claimed.add(charge.transaction.id);
      pairs.push({ reversalId: credit.transaction.id, originalId: charge.transaction.id });
      break;
    }
  }

  return { charges: charges.filter((m) => !claimed.has(m.transaction.id)), pairs };
}

// ── account partitioning ───────────────────────────────────────────────────────────────

/**
 * Whether two accounts billing the same merchant are two subscriptions or one that moved.
 *
 * A replaced card produces the same merchant on a new account with the old one falling silent;
 * a genuine duplicate produces both at once. Overlap in time is the only signal that separates
 * them, and it is a good one — so overlapping accounts are split into separate candidates (which
 * the duplicate pass then links back together for the user to judge), and sequential ones stay
 * merged so a card replacement does not look like a cancellation followed by a new subscription.
 */
function overlappingAccounts(byAccount: ReadonlyMap<string, readonly ClusterMember[]>): boolean {
  const ranges: { from: PlainDate; to: PlainDate }[] = [];
  for (const members of byAccount.values()) {
    if (members.length < SUSTAINED_CHARGES) continue;
    const from = members[0]?.transaction.postedAt;
    const to = members[members.length - 1]?.transaction.postedAt;
    if (from === undefined || to === undefined) continue;
    ranges.push({ from, to });
  }
  if (ranges.length < 2) return false;

  for (let i = 0; i < ranges.length; i += 1) {
    for (let j = i + 1; j < ranges.length; j += 1) {
      const a = ranges[i];
      const b = ranges[j];
      if (a === undefined || b === undefined) continue;
      if (comparePlainDate(a.from, b.to) <= 0 && comparePlainDate(b.from, a.to) <= 0) return true;
    }
  }
  return false;
}

// ── assembly ───────────────────────────────────────────────────────────────────────────

/** Majority channel, ties broken by whichever appeared first. Members share a key, not a path. */
function dominantChannel(members: readonly ClusterMember[]): BillingChannel {
  const counts = new Map<BillingChannel, number>();
  for (const member of members) {
    counts.set(member.descriptor.channel, (counts.get(member.descriptor.channel) ?? 0) + 1);
  }
  let best: BillingChannel = members[0]?.descriptor.channel ?? 'unknown';
  let bestCount = 0;
  for (const member of members) {
    const count = counts.get(member.descriptor.channel) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = member.descriptor.channel;
    }
  }
  return best;
}

function buildCluster(
  normalizedKey: string,
  currency: string,
  accountScope: string,
  charges: readonly ClusterMember[],
  bps: number,
): TransactionCluster {
  const { levels, outliers } = resolveLevels(charges, bps);
  const kept = levels.flat();
  const currentLevel = levels[levels.length - 1] ?? [];
  const currentAmounts = currentLevel.map((m) => m.transaction.amountMinor);
  const amountCv = coefficientOfVariation(currentAmounts);

  const accountIds = [...new Set(charges.map((m) => m.transaction.accountId))].sort();

  return {
    normalizedKey,
    currency,
    channel: dominantChannel(charges),
    accountScope,
    accountIds,
    charges: kept,
    levels: levels.map((members) => ({
      medianMinor: integerMedian(members.map((m) => m.transaction.amountMinor)),
      members,
      firstSeen: members[0]?.transaction.postedAt ?? {
        year: 1970,
        month: 1,
        day: 1,
      },
    })),
    outliers,
    medianAmountMinor: integerMedian(currentAmounts),
    amountCv,
    variableAmount: amountCv >= CV_VARIABLE_MIN && amountCv <= CV_VARIABLE_MAX,
    // Above the ceiling the "price" is not a price. Kept as a discard *reason* rather than
    // silently dropped, so "why is my electricity bill not a subscription?" has an answer.
    discardReason: amountCv > CV_VARIABLE_MAX ? 'amount_variance' : null,
  };
}

// ── entry point ────────────────────────────────────────────────────────────────────────

/**
 * Groups transactions into clusters, one per plausible billing relationship.
 *
 * Order of operations matters: pending rows and unrecoverable descriptors go first because they
 * are not evidence of anything; reversals are paired *per account* because a refund always lands
 * back on the card that was charged; the account split happens before amount segmentation so two
 * concurrent plans on two cards never contaminate each other's price history.
 */
export function clusterTransactions(
  transactions: readonly DetectionTransaction[],
  options: ClusterOptions = {},
): ClusterOutcome {
  const bps = options.amountToleranceBps ?? AMOUNT_BAND_BPS;
  const includePending = options.includePending ?? false;

  const groups = new Map<string, ClusterMember[]>();
  const discarded: DiscardedCluster[] = [];
  const unrecoverable = new Set<string>();

  for (const transaction of transactions) {
    if (transaction.pending && !includePending) continue;
    if (transaction.amountMinor === 0) {
      // A zero-amount row still carries a date, and the trial pass needs it. It cannot be
      // clustered on amount, but it clusters on descriptor like everything else.
      if (transaction.rawDescriptor.trim() === '') continue;
    }
    const descriptor = normalizeDescriptor(transaction.rawDescriptor);
    if (descriptor.normalized === '') {
      unrecoverable.add(transaction.rawDescriptor.trim().toUpperCase());
      continue;
    }
    // A normalized key is `[A-Z0-9 ]+`, so the separator cannot occur inside one and the pair
    // is recoverable by splitting at its first occurrence. Joining with a space instead would
    // let `ADOBE CREATIVE CLOUD` + `USD` and `ADOBE CREATIVE` + `CLOUD USD` collide.
    const key = `${descriptor.normalized}${KEY_SEPARATOR}${transaction.currency.toUpperCase()}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [{ transaction, descriptor }]);
    else bucket.push({ transaction, descriptor });
  }

  for (const raw of [...unrecoverable].sort()) {
    discarded.push({ normalizedKey: raw, reason: 'unrecoverable_descriptor' });
  }

  const clusters: TransactionCluster[] = [];
  const reversals: ReversalPair[] = [];

  for (const key of [...groups.keys()].sort()) {
    const members = groups.get(key) ?? [];
    const split = key.indexOf(KEY_SEPARATOR);
    const normalizedKey = key.slice(0, split);
    const currency = key.slice(split + 1);

    const byAccount = new Map<string, ClusterMember[]>();
    for (const member of members) {
      const bucket = byAccount.get(member.transaction.accountId);
      if (bucket === undefined) byAccount.set(member.transaction.accountId, [member]);
      else bucket.push(member);
    }

    const chargesByAccount = new Map<string, readonly ClusterMember[]>();
    for (const accountId of [...byAccount.keys()].sort()) {
      const sorted = [...(byAccount.get(accountId) ?? [])].sort(byPostedAt);
      const outcome = linkReversals(sorted);
      reversals.push(...outcome.pairs);
      if (outcome.charges.length > 0) chargesByAccount.set(accountId, outcome.charges);
    }
    if (chargesByAccount.size === 0) continue;

    if (chargesByAccount.size > 1 && overlappingAccounts(chargesByAccount)) {
      for (const [accountId, charges] of chargesByAccount) {
        clusters.push(buildCluster(normalizedKey, currency, accountId, charges, bps));
      }
    } else {
      const merged = [...chargesByAccount.values()].flat().sort(byPostedAt);
      clusters.push(buildCluster(normalizedKey, currency, 'all', merged, bps));
    }
  }

  return {
    clusters,
    reversals: [...reversals].sort((a, b) => a.reversalId.localeCompare(b.reversalId)),
    discarded,
  };
}

/** Date first, then id: two charges on one day must not reorder between runs. */
function byPostedAt(a: ClusterMember, b: ClusterMember): number {
  return (
    comparePlainDate(a.transaction.postedAt, b.transaction.postedAt) ||
    a.transaction.id.localeCompare(b.transaction.id)
  );
}
