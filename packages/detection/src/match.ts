/**
 * Merchant matching.
 *
 * Three strategies, tried in order of how much they can be trusted: an exact descriptor-pattern
 * hit, then a known alias appearing in the key, then trigram similarity. The order is the whole
 * design — a fuzzy match that fires before an exact one would let `SPOTIFY` claim a charge that
 * the registry already knew belonged to `SPOTIFY FAMILY`.
 *
 * A wrong match is worse than no match. It attaches the wrong cancellation playbook, and brief
 * §3.2 is explicit that telling a user to cancel somewhere they cannot is the failure mode this
 * product exists to avoid. Hence the deliberately unforgiving 0.82 trigram threshold and the
 * refusal to match an empty key at all.
 */

import { normalizeDescriptor, trigramSimilarity } from './normalize';
import {
  DEFAULT_TRIGRAM_THRESHOLD,
  type MerchantMatch,
  type MerchantRegistry,
  type MerchantRegistryEntry,
  type NormalizedDescriptor,
  type TextSpan,
} from './types';

const NO_MATCH: MerchantMatch = { merchantId: null, matchedVia: 'none', score: 0 };

/**
 * Alias hits score below an exact hit and above the trigram floor, scaled by how much of the key
 * the alias actually accounts for: `NETFLIX` covering all of `NETFLIX` is stronger evidence than
 * `PRIME` covering one token of `AMAZON PRIME VIDEO STORE`.
 */
const ALIAS_SCORE_FLOOR = 0.85;
const ALIAS_SCORE_RANGE = 0.1;

export function matchMerchant(
  descriptor: NormalizedDescriptor,
  registry: MerchantRegistry,
  trigramThreshold: number = DEFAULT_TRIGRAM_THRESHOLD,
): MerchantMatch {
  if (descriptor.normalized === '') return NO_MATCH;

  const exact = registry.byExactPattern(descriptor.normalized);
  if (exact !== null) {
    return withSpan({ merchantId: exact.id, matchedVia: 'exact', score: 1 }, fullSpan(descriptor));
  }

  const alias = matchByAlias(descriptor, registry);
  if (alias !== null) return alias;

  return matchByTrigram(descriptor, registry, trigramThreshold);
}

function matchByAlias(
  descriptor: NormalizedDescriptor,
  registry: MerchantRegistry,
): MerchantMatch | null {
  let best: { entry: MerchantRegistryEntry; start: number; length: number } | null = null;

  for (const entry of registry.all()) {
    for (const candidate of [entry.name, ...entry.aliases]) {
      const aliasTokens = normalizeDescriptor(candidate).tokens;
      if (aliasTokens.length === 0) continue;
      const start = indexOfTokenRun(descriptor.tokens, aliasTokens);
      if (start < 0) continue;
      // Longest alias wins: a registry that lists both `HBO` and `HBO MAX` should resolve
      // `HBO MAX` to the more specific one regardless of iteration order.
      if (best === null || aliasTokens.length > best.length) {
        best = { entry, start, length: aliasTokens.length };
      }
    }
  }

  if (best === null) return null;

  const coverage = best.length / descriptor.tokens.length;
  return withSpan(
    {
      merchantId: best.entry.id,
      matchedVia: 'alias',
      score: ALIAS_SCORE_FLOOR + ALIAS_SCORE_RANGE * coverage,
    },
    spanOfTokenRun(descriptor, best.start, best.length),
  );
}

function matchByTrigram(
  descriptor: NormalizedDescriptor,
  registry: MerchantRegistry,
  threshold: number,
): MerchantMatch {
  let bestEntry: MerchantRegistryEntry | null = null;
  let bestScore = 0;

  for (const entry of registry.all()) {
    for (const candidate of [entry.name, ...entry.aliases, ...entry.descriptorPatterns]) {
      const score = trigramSimilarity(
        descriptor.normalized,
        normalizeDescriptor(candidate).normalized,
      );
      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }
  }

  if (bestEntry === null || bestScore < threshold) return NO_MATCH;
  return withSpan(
    { merchantId: bestEntry.id, matchedVia: 'trigram', score: bestScore },
    fullSpan(descriptor),
  );
}

/** Index of the first occurrence of `run` as a contiguous slice of `tokens`, or -1. */
function indexOfTokenRun(tokens: readonly string[], run: readonly string[]): number {
  if (run.length === 0 || run.length > tokens.length) return -1;
  for (let start = 0; start + run.length <= tokens.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < run.length; offset += 1) {
      if (tokens[start + offset] !== run[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

function spanOfTokenRun(
  descriptor: NormalizedDescriptor,
  start: number,
  length: number,
): TextSpan | null {
  const first = descriptor.tokenSpans[start];
  const last = descriptor.tokenSpans[start + length - 1];
  if (first === undefined || last === undefined) return null;
  return { start: first.start, end: last.end };
}

/** Everything the key was built from, as one range in the raw descriptor. */
function fullSpan(descriptor: NormalizedDescriptor): TextSpan | null {
  const first = descriptor.tokenSpans[0];
  const last = descriptor.tokenSpans[descriptor.tokenSpans.length - 1];
  if (first === undefined || last === undefined) return null;
  return { start: first.start, end: last.end };
}

function withSpan(match: Omit<MerchantMatch, 'matchedSpan'>, span: TextSpan | null): MerchantMatch {
  return span === null ? match : { ...match, matchedSpan: span };
}

/**
 * A registry backed by an array, for tests and for callers that have already loaded the provider
 * dataset into memory. The real data ships in `@ledger/providers`; this is only the lookup.
 */
export function createInMemoryRegistry(
  entries: readonly MerchantRegistryEntry[],
): MerchantRegistry {
  const byPattern = new Map<string, MerchantRegistryEntry>();
  for (const entry of entries) {
    for (const pattern of entry.descriptorPatterns) {
      const key = normalizeDescriptor(pattern).normalized;
      // First registration wins, so a later entry cannot silently steal another's descriptor.
      if (key !== '' && !byPattern.has(key)) byPattern.set(key, entry);
    }
  }
  return {
    byExactPattern: (key) => byPattern.get(key) ?? null,
    all: () => entries,
  };
}
