/**
 * The acceptance test for detection quality (PLAN.md Phase 4).
 *
 * Everything else in this suite asks whether a specific behaviour is correct. This one asks the
 * only question the product cares about: over two years of a realistic statement, how many of the
 * user's subscriptions does the engine find, and how much does it make up? Both are numbers, both
 * are asserted, and neither is allowed to be a matter of opinion — which is the entire reason
 * `synthetic.ts` carries its own ground truth.
 *
 * Three seeds, because a single dataset can be lucky. The seeds are fixed rather than sampled so
 * that a failure is reproducible from the test name alone; if the engine is only good on one
 * corpus, that shows up here as a red seed rather than as an intermittent CI failure.
 *
 * On failure the assertion message carries the full confusion detail — which planted
 * subscriptions went missing and why the engine says it discarded them, and which candidates were
 * invented from noise. A regression that only tells you "0.91 is not ≥ 0.95" costs an afternoon.
 */

import { formatPlainDate, intervalLabel } from '@ledger/core';
import { describe, expect, it } from 'vitest';

import { detectSubscriptions } from '../src/detect';
import type { SubscriptionCandidate } from '../src/types';
import { generateSyntheticCorpus, type SyntheticCorpus } from './synthetic';

const SEEDS = [1, 20_260_720, 987_654_321] as const;

/** Brief §11 / PLAN.md Phase 4. Moving either of these down is a product decision, not a fix. */
const MIN_RECALL = 0.95;
const MAX_FALSE_POSITIVE_RATE = 0.05;

interface Measurement {
  readonly recall: number;
  readonly falsePositiveRate: number;
  readonly detail: string;
}

/**
 * Which planted subscription a candidate is reporting, or null if it invented one.
 *
 * Attribution is by majority of the candidate's own transactions rather than by descriptor key:
 * a key match would quietly forgive a candidate that had swept unrelated rows into the cluster,
 * and that is precisely the failure worth catching.
 */
function attribute(
  candidate: SubscriptionCandidate,
  owners: ReadonlyMap<string, string>,
): string | null {
  const votes = new Map<string, number>();
  for (const transactionId of candidate.transactionIds) {
    const owner = owners.get(transactionId);
    if (owner === undefined) continue;
    votes.set(owner, (votes.get(owner) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestVotes = 0;
  for (const [owner, count] of [...votes].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestVotes) {
      bestVotes = count;
      best = owner;
    }
  }
  return bestVotes * 2 > candidate.transactionIds.length ? best : null;
}

function measure(corpus: SyntheticCorpus): Measurement {
  const result = detectSubscriptions(corpus.transactions, {
    today: corpus.today,
    registry: corpus.registry,
  });

  const owners = new Map<string, string>();
  for (const subscription of corpus.planted) {
    for (const transactionId of subscription.transactionIds)
      owners.set(transactionId, subscription.id);
  }

  const recovered = new Set<string>();
  const falsePositives: SubscriptionCandidate[] = [];
  for (const candidate of result.candidates) {
    const owner = attribute(candidate, owners);
    if (owner === null) falsePositives.push(candidate);
    else recovered.add(owner);
  }

  const missed = corpus.planted.filter((subscription) => !recovered.has(subscription.id));

  // The engine records a reason for everything it drops. Quoting it here is the difference
  // between "recall regressed" and "recall regressed because the amount filter got stricter".
  const reasons = new Map<string, string[]>();
  for (const entry of result.discarded) {
    const list = reasons.get(entry.normalizedKey) ?? [];
    list.push(entry.reason);
    reasons.set(entry.normalizedKey, list);
  }

  const lines = [
    `seed ${String(corpus.seed)}: ${String(corpus.transactions.length)} transactions, ` +
      `${String(corpus.planted.length)} planted, ${String(result.candidates.length)} candidates.`,
    `missed ${String(missed.length)}:`,
    ...missed.map(
      (subscription) =>
        `  - ${subscription.id} [${subscription.normalizedKey} ${subscription.currency} ` +
        `${intervalLabel(subscription.interval)}] ` +
        `discarded as ${(reasons.get(subscription.normalizedKey) ?? ['not considered at all']).join('/')} ` +
        `— ${subscription.note}`,
    ),
    `false positives ${String(falsePositives.length)}:`,
    ...falsePositives.map(
      (candidate) =>
        `  - ${candidate.normalizedKey} ${candidate.currency} ${intervalLabel(candidate.interval)} ` +
        `x${String(candidate.occurrences)} @ ${String(candidate.medianAmountMinor)} ` +
        `cv=${candidate.amountCv.toFixed(3)} confidence=${candidate.confidence.toFixed(3)} ` +
        `${formatPlainDate(candidate.firstSeen)}..${formatPlainDate(candidate.lastSeen)}`,
    ),
  ];

  return {
    recall: corpus.planted.length === 0 ? 1 : recovered.size / corpus.planted.length,
    falsePositiveRate:
      result.candidates.length === 0 ? 0 : falsePositives.length / result.candidates.length,
    detail: lines.join('\n'),
  };
}

describe('golden — detection quality over a synthetic 24-month history', () => {
  for (const seed of SEEDS) {
    it(`recovers at least 95% of planted subscriptions with under 5% false positives (seed ${String(seed)})`, () => {
      const outcome = measure(generateSyntheticCorpus(seed));

      // Printed on success as well as failure. The assertion proves the floor held; the number
      // says how much headroom there was, and a run that drifts from 1.00 to 0.96 is a warning
      // long before it is a red build.
      console.info(
        `[golden seed ${String(seed)}] recall ${outcome.recall.toFixed(4)} ` +
          `(floor ${MIN_RECALL.toFixed(2)}) · false positives ${outcome.falsePositiveRate.toFixed(4)} ` +
          `(ceiling ${MAX_FALSE_POSITIVE_RATE.toFixed(2)})`,
      );

      expect(outcome.recall, outcome.detail).toBeGreaterThanOrEqual(MIN_RECALL);
      expect(outcome.falsePositiveRate, outcome.detail).toBeLessThan(MAX_FALSE_POSITIVE_RATE);
    });
  }

  it('reports each planted subscription exactly once, however its descriptor varies', () => {
    // Recall alone cannot see fragmentation: a merchant split into two half-length candidates
    // still counts as recovered, and still shows the user two subscriptions where they have one.
    // The only planted series allowed two candidates is the one genuinely billing two cards.
    for (const seed of SEEDS) {
      const corpus = generateSyntheticCorpus(seed);
      const result = detectSubscriptions(corpus.transactions, {
        today: corpus.today,
        registry: corpus.registry,
      });
      const owners = new Map<string, string>();
      for (const subscription of corpus.planted) {
        for (const transactionId of subscription.transactionIds) {
          owners.set(transactionId, subscription.id);
        }
      }

      const counts = new Map<string, number>();
      for (const candidate of result.candidates) {
        const owner = attribute(candidate, owners);
        if (owner === null) continue;
        counts.set(owner, (counts.get(owner) ?? 0) + 1);
      }

      for (const subscription of corpus.planted) {
        const expected = subscription.id === 'dropbox-duplicate' ? 2 : 1;
        expect(
          counts.get(subscription.id),
          `seed ${String(seed)}: ${subscription.id} fragmented — ${subscription.note}`,
        ).toBe(expected);
      }
    }
  });

  it('never reports either of the deliberate near-misses', () => {
    for (const seed of SEEDS) {
      const corpus = generateSyntheticCorpus(seed);
      const result = detectSubscriptions(corpus.transactions, {
        today: corpus.today,
        registry: corpus.registry,
      });
      const surfaced = result.candidates.map((candidate) => candidate.normalizedKey);
      for (const key of corpus.nearMissKeys) {
        expect(surfaced, `seed ${String(seed)} surfaced the near-miss ${key}`).not.toContain(key);
      }
    }
  });

  it('is deterministic: the same seed produces byte-identical detections', () => {
    // Two independent generations from one seed, not one corpus detected twice — that would only
    // prove `detectSubscriptions` is a function. What has to hold is that the whole chain, corpus
    // included, is reproducible, because a golden file is worthless otherwise.
    const a = generateSyntheticCorpus(7);
    const b = generateSyntheticCorpus(7);
    expect(JSON.stringify(b.transactions)).toBe(JSON.stringify(a.transactions));

    const first = detectSubscriptions(a.transactions, { today: a.today, registry: a.registry });
    const second = detectSubscriptions(b.transactions, { today: b.today, registry: b.registry });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('is the corpus it claims to be: 24 months, two currencies, 300+ noise rows', () => {
    const corpus = generateSyntheticCorpus(SEEDS[0]);
    for (const seed of SEEDS) {
      const each = generateSyntheticCorpus(seed);
      expect(each.noiseTransactionIds.length, `seed ${String(seed)}`).toBeGreaterThanOrEqual(300);
    }
    expect(corpus.planted.length).toBeGreaterThanOrEqual(18);
    expect(new Set(corpus.planted.map((entry) => entry.currency))).toEqual(new Set(['USD', 'EUR']));
    expect(new Set(corpus.planted.map((entry) => intervalLabel(entry.interval)))).toEqual(
      new Set(['Weekly', 'Every 4 weeks', 'Monthly', 'Quarterly', 'Annually']),
    );

    const first = corpus.transactions[0];
    const last = corpus.transactions[corpus.transactions.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect(formatPlainDate(first?.postedAt ?? corpus.today) >= '2024-07').toBe(true);
    expect(formatPlainDate(last?.postedAt ?? corpus.windowStart) <= '2026-07-20').toBe(true);
  });
});
