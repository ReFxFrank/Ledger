/**
 * Confidence mechanics.
 *
 * Two properties matter more than any individual weight: the breakdown always sums to the score
 * (or the review queue is showing the user a fiction), and the occurrence caps from brief §4.3
 * cannot be argued around by piling on other evidence.
 */

import { ANNUAL, MONTHLY, QUARTERLY } from '@ledger/core';
import { describe, expect, it } from 'vitest';

import {
  AUTO_CONFIRM_THRESHOLD,
  SURFACE_THRESHOLD,
  canAutoConfirm,
  hasRecurrenceMarker,
  scoreConfidence,
  type ConfidenceInput,
} from './confidence';
import type { MerchantMatch, MerchantRegistryEntry, SubscriptionCandidate } from './types';

const EXACT_MATCH: MerchantMatch = { merchantId: 'netflix', matchedVia: 'exact', score: 1 };
const TRIGRAM_MATCH: MerchantMatch = { merchantId: 'netflix', matchedVia: 'trigram', score: 0.85 };
const NO_MATCH: MerchantMatch = { merchantId: null, matchedVia: 'none', score: 0 };

const NETFLIX: MerchantRegistryEntry = {
  id: 'netflix',
  name: 'Netflix',
  aliases: [],
  descriptorPatterns: ['NETFLIX'],
  typicalIntervals: [MONTHLY],
  category: 'streaming_video',
};

/** A strong candidate; individual tests weaken one axis at a time. */
function input(overrides: Partial<ConfidenceInput> = {}): ConfidenceInput {
  return {
    occurrences: 6,
    jitterScore: 1,
    missedPeriods: 0,
    amountCv: 0,
    merchantMatch: EXACT_MATCH,
    registryEntry: NETFLIX,
    interval: MONTHLY,
    sampleDescriptors: ['NETFLIX.COM'],
    ...overrides,
  };
}

const sumOf = (factors: Readonly<Record<string, number>>) =>
  Object.values(factors).reduce((total, value) => total + value, 0);

describe('scoreConfidence — the breakdown is the score', () => {
  it('sums its factors to exactly the score it reports', () => {
    for (const occurrences of [1, 2, 3, 4, 9]) {
      for (const jitterScore of [0, 0.4, 1]) {
        for (const amountCv of [0, 0.2, 0.9]) {
          const result = scoreConfidence(input({ occurrences, jitterScore, amountCv }));
          expect(sumOf(result.factors)).toBeCloseTo(result.score, 10);
        }
      }
    }
  });

  it('records the cap as a named negative rather than silently clipping', () => {
    const result = scoreConfidence(input({ occurrences: 2 }));
    expect(result.factors.occurrenceCap).toBeLessThan(0);
    expect(result.score).toBe(0.5);
  });

  it('names every input that contributed', () => {
    const result = scoreConfidence(input({ sampleDescriptors: ['RECURRING PMT NETFLIX.COM'] }));
    expect(Object.keys(result.factors).sort()).toEqual([
      'amountStability',
      'cadenceRegularity',
      'clamp',
      'merchantRegistry',
      'occurrences',
      'recurrenceMarker',
      'typicalInterval',
    ]);
  });
});

describe('scoreConfidence — occurrence caps (brief §4.3)', () => {
  it('caps two occurrences at 0.5 however strong the other evidence is', () => {
    const result = scoreConfidence(
      input({ occurrences: 2, sampleDescriptors: ['RECURRING SUBSCRIPTION NETFLIX.COM'] }),
    );
    expect(result.score).toBe(0.5);
  });

  it('caps three occurrences at 0.75', () => {
    expect(scoreConfidence(input({ occurrences: 3 })).score).toBe(0.75);
  });

  it('leaves four or more uncapped', () => {
    expect(scoreConfidence(input({ occurrences: 4 })).score).toBeGreaterThan(0.75);
  });

  it('lands a registry-asserted single occurrence exactly on the surface threshold', () => {
    // Brief §4.4's annual-from-one-occurrence: shown and asked about, never assumed.
    const result = scoreConfidence(
      input({
        occurrences: 1,
        jitterScore: 0,
        interval: ANNUAL,
        registryEntry: { ...NETFLIX, typicalIntervals: [ANNUAL] },
        sampleDescriptors: ['NAMECHEAP.COM'],
      }),
    );
    expect(result.score).toBe(SURFACE_THRESHOLD);
  });
});

describe('scoreConfidence — evidence', () => {
  it('rewards a punctual cadence over a jittery one', () => {
    const punctual = scoreConfidence(input({ occurrences: 4, jitterScore: 1 })).score;
    const jittery = scoreConfidence(input({ occurrences: 4, jitterScore: 0.2 })).score;
    expect(punctual).toBeGreaterThan(jittery);
  });

  it('discounts a fuzzy merchant match against an exact one', () => {
    const exact = scoreConfidence(input({ occurrences: 4, merchantMatch: EXACT_MATCH }));
    const fuzzy = scoreConfidence(input({ occurrences: 4, merchantMatch: TRIGRAM_MATCH }));
    expect(fuzzy.factors.merchantRegistry).toBeLessThan(exact.factors.merchantRegistry ?? 0);
  });

  it('pays nothing for a registry match that is not there', () => {
    const result = scoreConfidence(
      input({ occurrences: 4, merchantMatch: NO_MATCH, registryEntry: null }),
    );
    expect(result.factors.merchantRegistry).toBe(0);
    expect(result.factors.typicalInterval).toBe(0);
  });

  it('pays for an interval the registry independently expects, and not otherwise', () => {
    expect(scoreConfidence(input({ interval: MONTHLY })).factors.typicalInterval).toBeGreaterThan(
      0,
    );
    expect(scoreConfidence(input({ interval: QUARTERLY })).factors.typicalInterval).toBe(0);
  });

  it('costs a metered subscription some amount stability but does not sink it', () => {
    const fixed = scoreConfidence(input({ occurrences: 9, amountCv: 0 }));
    const metered = scoreConfidence(input({ occurrences: 9, amountCv: 0.25 }));
    expect(metered.factors.amountStability).toBeLessThan(fixed.factors.amountStability ?? 0);
    expect(metered.score).toBeGreaterThan(SURFACE_THRESHOLD);
  });

  it('penalises missed periods, up to a cap', () => {
    const clean = scoreConfidence(input({ occurrences: 9, missedPeriods: 0 }));
    const patchy = scoreConfidence(input({ occurrences: 9, missedPeriods: 2 }));
    const worse = scoreConfidence(input({ occurrences: 9, missedPeriods: 20 }));
    expect(patchy.factors.missedPeriods).toBeLessThan(0);
    expect(clean.factors.missedPeriods).toBeUndefined();
    expect(worse.factors.missedPeriods).toBe(-0.12);
  });

  it('never leaves the 0..1 range', () => {
    const floor = scoreConfidence(
      input({
        occurrences: 9,
        jitterScore: 0,
        amountCv: 5,
        missedPeriods: 40,
        merchantMatch: NO_MATCH,
        registryEntry: null,
        sampleDescriptors: ['SOMETHING'],
      }),
    );
    expect(floor.score).toBeGreaterThanOrEqual(0);
    expect(scoreConfidence(input({ occurrences: 12 })).score).toBeLessThanOrEqual(1);
  });
});

describe('hasRecurrenceMarker', () => {
  it('finds markers in the raw descriptor, where normalization would have stripped them', () => {
    expect(hasRecurrenceMarker(['RECURRING PMT NETFLIX.COM'])).toBe(true);
    expect(hasRecurrenceMarker(['ADOBE ACROPRO SUBSCR'])).toBe(true);
    expect(hasRecurrenceMarker(['PELOTON MEMBERSHIP'])).toBe(true);
    expect(hasRecurrenceMarker(['DD SPOTIFY UK'])).toBe(true);
    expect(hasRecurrenceMarker(['FIGMA MONTHLY'])).toBe(true);
  });

  it('reads lowercase descriptors and non-English markers', () => {
    expect(hasRecurrenceMarker(['spotify abonnement'])).toBe(true);
    expect(hasRecurrenceMarker(['NETFLIX JAHRESABO'])).toBe(true);
  });

  it('does not fire on a marker buried inside another word', () => {
    expect(hasRecurrenceMarker(['DDOS PROTECTION LTD'])).toBe(false);
    expect(hasRecurrenceMarker(['NETFLIX.COM'])).toBe(false);
  });

  it('checks every descriptor it is given', () => {
    expect(hasRecurrenceMarker(['NETFLIX.COM', 'RECURRING PMT NETFLIX'])).toBe(true);
    expect(hasRecurrenceMarker([])).toBe(false);
  });
});

describe('canAutoConfirm', () => {
  const candidate = (confidence: number, merchantId: string | null): SubscriptionCandidate =>
    ({
      confidence,
      merchantMatch: { merchantId, matchedVia: merchantId === null ? 'none' : 'exact', score: 1 },
    }) as SubscriptionCandidate;

  it('requires the score and a known merchant, not either one alone', () => {
    expect(canAutoConfirm(candidate(0.97, 'netflix'))).toBe(true);
    // Certain that something recurs, no idea what — so no cancellation route to attach.
    expect(canAutoConfirm(candidate(0.99, null))).toBe(false);
    expect(canAutoConfirm(candidate(0.89, 'netflix'))).toBe(false);
  });

  it('treats the threshold itself as sufficient', () => {
    expect(canAutoConfirm(candidate(AUTO_CONFIRM_THRESHOLD, 'netflix'))).toBe(true);
  });
});
