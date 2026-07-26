/**
 * The detection pipeline (brief §4).
 *
 * normalize → cluster → link reversals → infer cadence → apply the §4.4 edge cases → score →
 * filter → link duplicates. Each stage is a pure function in its own file; this one wires them
 * together and is responsible for the two properties the rest of the system depends on.
 *
 * **Determinism.** The same transactions produce byte-identical output, every time, on any
 * machine. That means no `Date.now()`, no `uuidv7()`, no `Map` iteration without a sort, and no
 * floating-point comparison deciding an ordering. Candidate ids are derived from the cluster
 * identity rather than generated, so a detection run that happens twice does not produce two
 * copies of the same subscription in the review queue — and so a golden-file test is possible at
 * all, which brief §11 requires because "detection quality" is otherwise a matter of opinion.
 *
 * **Nothing disappears silently.** Every cluster that does not become a candidate is recorded in
 * `discarded` with a reason. "Why is my gym membership not showing up?" is the question this
 * engine will be asked most often, and the answer has to be in the output rather than in a
 * debugger.
 */

import { type PlainDate, type RecurrenceInterval, dedupeKey } from '@ledger/core';

import { inferCadence, projectNextExpected } from './cadence';
import { type ClusterMember, type TransactionCluster, clusterTransactions } from './cluster';
import { scoreConfidence } from './confidence';
import {
  assumedLongInterval,
  assumedTrialInterval,
  detectPriceChange,
  detectTrial,
  findDuplicateGroups,
  statusFor,
} from './edge-cases';
import { matchMerchant } from './match';
import {
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_OCCURRENCES,
  DEFAULT_TRIGRAM_THRESHOLD,
  type DetectionOptions,
  type DetectionResult,
  type DetectionTransaction,
  type DiscardedCluster,
  type MerchantMatch,
  type MerchantRegistryEntry,
  type SubscriptionCandidate,
} from './types';

const NO_MATCH: MerchantMatch = { merchantId: null, matchedVia: 'none', score: 0 };

/** How many raw descriptors travel with a candidate for the §6.4 decoder view. */
const SAMPLE_DESCRIPTOR_LIMIT = 3;

export function detectSubscriptions(
  transactions: readonly DetectionTransaction[],
  options: DetectionOptions,
): DetectionResult {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const minOccurrences = options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const trigramThreshold = options.trigramThreshold ?? DEFAULT_TRIGRAM_THRESHOLD;

  const clustered = clusterTransactions(transactions, {
    includePending: options.includePending,
    amountToleranceBps: options.amountToleranceBps,
  });

  const registryById = new Map<string, MerchantRegistryEntry>();
  for (const entry of options.registry?.all() ?? []) registryById.set(entry.id, entry);

  const candidates: SubscriptionCandidate[] = [];
  const discarded: DiscardedCluster[] = [...clustered.discarded];

  for (const cluster of clustered.clusters) {
    if (cluster.discardReason !== null) {
      discarded.push({ normalizedKey: cluster.normalizedKey, reason: cluster.discardReason });
      continue;
    }

    const merchantMatch = matchClusterMerchant(cluster, options, trigramThreshold);
    const registryEntry =
      merchantMatch.merchantId === null
        ? null
        : (registryById.get(merchantMatch.merchantId) ?? null);

    const built = buildCandidate(cluster, merchantMatch, registryEntry, options, minOccurrences);
    if (typeof built === 'string') {
      discarded.push({ normalizedKey: cluster.normalizedKey, reason: built });
      continue;
    }
    if (built.confidence < minConfidence) {
      discarded.push({ normalizedKey: cluster.normalizedKey, reason: 'below_confidence' });
      continue;
    }
    candidates.push(built);
  }

  candidates.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.normalizedKey.localeCompare(b.normalizedKey) ||
      a.id.localeCompare(b.id),
  );

  return {
    candidates,
    duplicates: findDuplicateGroups(candidates),
    reversals: clustered.reversals,
    discarded: dedupeDiscarded(discarded),
  };
}

// ── merchant ───────────────────────────────────────────────────────────────────────────

/**
 * Matches on the descriptor of the earliest charge.
 *
 * Every member of a cluster shares a normalized key, so any of them resolves to the same
 * merchant; the earliest is chosen only so the choice is stable when a merchant later changes
 * the raw shape of its descriptor.
 */
function matchClusterMerchant(
  cluster: TransactionCluster,
  options: DetectionOptions,
  trigramThreshold: number,
): MerchantMatch {
  const registry = options.registry;
  const first = cluster.charges[0];
  if (registry === undefined || first === undefined) return NO_MATCH;
  return matchMerchant(first.descriptor, registry, trigramThreshold);
}

// ── candidate assembly ─────────────────────────────────────────────────────────────────

/**
 * Turns one cluster into a candidate, or names the reason it cannot be one.
 *
 * Returning the discard reason rather than null is what keeps `discarded` honest: there is no
 * path out of this function that drops a cluster without saying why.
 */
function buildCandidate(
  cluster: TransactionCluster,
  merchantMatch: MerchantMatch,
  registryEntry: MerchantRegistryEntry | null,
  options: DetectionOptions,
  minOccurrences: number,
): SubscriptionCandidate | DiscardedCluster['reason'] {
  const dates = cluster.charges.map((member) => member.transaction.postedAt);
  const cadence = inferCadence(dates, { toleranceDays: options.dateToleranceDays });

  const trial = detectTrial(cluster, registryEntry);

  if (cadence === null) {
    // One charge cannot establish a cadence, so the only way it becomes a candidate is if
    // something outside the transaction data asserts one. Brief §4.4 names both cases: a
    // merchant the registry says bills annually (otherwise the user does not see that charge
    // again for eleven months), and a trial that has not converted yet (where the whole point is
    // to warn *before* the first real charge). Anything else with no cadence is not a
    // subscription and says so.
    const only = cluster.charges.length === 1 ? cluster.charges[0] : undefined;
    const assumed = trial.isTrial
      ? assumedTrialInterval(registryEntry)
      : assumedLongInterval(registryEntry);
    if (assumed === null || only === undefined) {
      return cluster.charges.length < minOccurrences ? 'too_few_occurrences' : 'irregular_cadence';
    }
    return assemble({
      cluster,
      merchantMatch,
      registryEntry,
      members: [only],
      interval: assumed,
      anchor: only.transaction.postedAt,
      gapDays: [],
      jitterScore: 0,
      missedPeriods: 0,
      trial,
      today: options.today,
    });
  }

  const members = cadence.matchedIndices
    .map((index) => cluster.charges[index])
    .filter((member): member is ClusterMember => member !== undefined);
  if (members.length < minOccurrences) return 'too_few_occurrences';

  return assemble({
    cluster,
    merchantMatch,
    registryEntry,
    members,
    interval: cadence.interval,
    anchor: cadence.anchor,
    gapDays: cadence.gapDays,
    jitterScore: cadence.jitterScore,
    missedPeriods: cadence.missedPeriods,
    trial,
    today: options.today,
  });
}

interface AssembleInput {
  readonly cluster: TransactionCluster;
  readonly merchantMatch: MerchantMatch;
  readonly registryEntry: MerchantRegistryEntry | null;
  readonly members: readonly ClusterMember[];
  readonly interval: RecurrenceInterval;
  readonly anchor: PlainDate;
  readonly gapDays: readonly number[];
  readonly jitterScore: number;
  readonly missedPeriods: number;
  readonly trial: ReturnType<typeof detectTrial>;
  readonly today: PlainDate;
}

function assemble(input: AssembleInput): SubscriptionCandidate {
  const { cluster, members } = input;
  const first = members[0];
  const last = members[members.length - 1];
  const firstSeen = first?.transaction.postedAt ?? input.anchor;
  const lastSeen = last?.transaction.postedAt ?? input.anchor;

  const sampleDescriptors = uniqueDescriptors(members);
  const confidence = scoreConfidence({
    occurrences: members.length,
    jitterScore: input.jitterScore,
    missedPeriods: input.missedPeriods,
    amountCv: cluster.amountCv,
    merchantMatch: input.merchantMatch,
    registryEntry: input.registryEntry,
    interval: input.interval,
    sampleDescriptors,
  });

  return {
    id: dedupeKey(cluster.normalizedKey, cluster.currency, cluster.accountScope),
    normalizedKey: cluster.normalizedKey,
    merchantMatch: input.merchantMatch,
    channel: cluster.channel,
    interval: input.interval,
    medianAmountMinor: cluster.medianAmountMinor,
    currency: cluster.currency,
    amountCv: cluster.amountCv,
    occurrences: members.length,
    firstSeen,
    lastSeen,
    nextExpectedAt: projectNextExpected(input.anchor, input.interval, lastSeen, input.today),
    confidence: confidence.score,
    status: statusFor(input.trial, lastSeen, input.interval, input.today),
    accountIds: cluster.accountIds,
    variableAmount: cluster.variableAmount,
    isTrial: input.trial.isTrial,
    trialEndsAt: input.trial.trialEndsAt,
    priceChange: detectPriceChange(cluster.levels, cluster.currency),
    transactionIds: members.map((member) => member.transaction.id),
    gapDays: input.gapDays,
    confidenceFactors: confidence.factors,
    sampleDescriptors,
  };
}

/**
 * A few distinct raw descriptors, oldest first.
 *
 * Distinct rather than deduped-to-one: the decoder is most useful precisely when a merchant
 * bills under two shapes, and showing only the first hides the variation the user is trying to
 * understand.
 */
function uniqueDescriptors(members: readonly ClusterMember[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const member of members) {
    const raw = member.transaction.rawDescriptor;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length === SAMPLE_DESCRIPTOR_LIMIT) break;
  }
  return out;
}

/**
 * One row per (key, reason).
 *
 * An account split can produce the same key twice with the same reason, and two identical rows
 * in the "why is this missing" list is noise, not information.
 */
function dedupeDiscarded(entries: readonly DiscardedCluster[]): DiscardedCluster[] {
  const seen = new Set<string>();
  const out: DiscardedCluster[] = [];
  for (const entry of entries) {
    const key = `${entry.normalizedKey}|${entry.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.sort(
    (a, b) => a.normalizedKey.localeCompare(b.normalizedKey) || a.reason.localeCompare(b.reason),
  );
}
