/**
 * Descriptor normalization and merchant matching.
 *
 * The bulk of this file is one assertion per corpus entry. That is deliberate: `descriptors.ts`
 * is the spec, and a failure should name the exact descriptor that regressed rather than report
 * that "the corpus" broke.
 *
 * The invariant suites after it are the ones worth reading. They state the properties the rest of
 * the engine relies on — the key is a fixed point, the spans really do index the raw string —
 * which no single example can establish.
 */

import { BILLING_CHANNELS, MONTHLY, type Category, type RecurrenceInterval } from '@ledger/core';
import { describe, expect, it } from 'vitest';

import { createInMemoryRegistry, matchMerchant } from '../src/match';
import { normalizeDescriptor, normalizedKeyOf, trigramSimilarity } from '../src/normalize';
import { DEFAULT_TRIGRAM_THRESHOLD, type MerchantRegistryEntry } from '../src/types';
import { DESCRIPTOR_FIXTURES } from './fixtures/descriptors';

/** Keys the normalizer synthesises from the channel marker when the descriptor named no merchant. */
const CHANNEL_FALLBACK_KEYS = new Set([
  'APPLE',
  'GOOGLE',
  'AMAZON',
  'PAYPAL',
  'ROKU',
  'CARRIER',
  'MICROSOFT',
  'STEAM',
]);

// ── the corpus ─────────────────────────────────────────────────────────────────────────

describe('normalizeDescriptor over the descriptor corpus', () => {
  for (const fixture of DESCRIPTOR_FIXTURES) {
    it(`normalizes ${JSON.stringify(fixture.raw)}`, () => {
      const result = normalizeDescriptor(fixture.raw);
      expect(result.normalized).toBe(fixture.expectedNormalized);
      expect(result.channel).toBe(fixture.expectedChannel);
    });
  }
});

describe('the corpus itself', () => {
  it('is large enough to be a spec rather than a sample', () => {
    expect(DESCRIPTOR_FIXTURES.length).toBeGreaterThanOrEqual(300);
  });

  it('contains no duplicate raw descriptors', () => {
    const seen = new Set<string>();
    const duplicates = DESCRIPTOR_FIXTURES.filter((fixture) => {
      if (seen.has(fixture.raw)) return true;
      seen.add(fixture.raw);
      return false;
    });
    expect(duplicates.map((fixture) => fixture.raw)).toEqual([]);
  });

  it('covers every billing channel the normalizer can produce', () => {
    const covered = new Set(DESCRIPTOR_FIXTURES.map((fixture) => fixture.expectedChannel));
    // `unknown` is reserved for callers that could not determine a channel at all; the
    // normalizer itself never emits it, and a descriptor with no marker is `direct`.
    const expected = BILLING_CHANNELS.filter((channel) => channel !== 'unknown');
    expect([...covered].sort()).toEqual([...expected].sort());
  });

  it('keeps a false-positive guard: everyday retail descriptors that must normalize cleanly', () => {
    const retail = [
      "TRADER JOE'S #123 PASADENA CA",
      'WHOLE FOODS MKT 10123 AUSTIN TX',
      'CHIPOTLE 1234 CHICAGO IL',
      'ATM FEE',
      'TRANSFER TO SAVINGS 1234567890',
    ];
    const present = retail.filter((raw) =>
      DESCRIPTOR_FIXTURES.some(
        (fixture) => fixture.raw === raw && fixture.expectedNormalized !== '',
      ),
    );
    expect(present).toEqual(retail);
  });
});

// ── invariants ─────────────────────────────────────────────────────────────────────────

describe('normalization invariants', () => {
  it('produces a key that is a fixed point of itself', () => {
    // Keys are stored and re-clustered. If normalizing a key changed it, every stored key would
    // drift a little further from the descriptors it was built from on each pass.
    const drifted = DESCRIPTOR_FIXTURES.map((fixture) => fixture.expectedNormalized).filter(
      (key) => normalizedKeyOf(key) !== key,
    );
    expect(drifted).toEqual([]);
  });

  it('emits stripped spans that index into the raw descriptor, in order and without overlap', () => {
    const problems: string[] = [];
    for (const fixture of DESCRIPTOR_FIXTURES) {
      const { strippedSpans } = normalizeDescriptor(fixture.raw);
      let previousEnd = 0;
      for (const span of strippedSpans) {
        if (span.start < previousEnd)
          problems.push(`${fixture.raw}: overlap at ${String(span.start)}`);
        if (span.start >= span.end) problems.push(`${fixture.raw}: empty span`);
        if (span.end > fixture.raw.length) problems.push(`${fixture.raw}: span past end`);
        previousEnd = span.end;
      }
    }
    expect(problems).toEqual([]);
  });

  it('emits one token span per token, each quoting that token out of the raw descriptor', () => {
    const problems: string[] = [];
    for (const fixture of DESCRIPTOR_FIXTURES) {
      const result = normalizeDescriptor(fixture.raw);
      expect(result.tokenSpans).toHaveLength(result.tokens.length);
      // The synthesised channel keys are the documented exception: their span points at the
      // marker the key stands in for, not at the key text, which is not in `raw` at all.
      if (result.tokens.length === 1 && CHANNEL_FALLBACK_KEYS.has(result.normalized)) continue;
      result.tokens.forEach((token, index) => {
        const span = result.tokenSpans[index];
        const quoted = fixture.raw
          .slice(span?.start ?? 0, span?.end ?? 0)
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '');
        if (quoted !== token) problems.push(`${fixture.raw}: ${token} != ${quoted}`);
      });
    }
    expect(problems).toEqual([]);
  });

  it('never returns a key with leading, trailing, or doubled whitespace', () => {
    const malformed = DESCRIPTOR_FIXTURES.map(
      (fixture) => normalizeDescriptor(fixture.raw).normalized,
    ).filter((key) => key !== key.trim() || key.includes('  '));
    expect(malformed).toEqual([]);
  });

  it('keeps tokens and the key in agreement', () => {
    for (const fixture of DESCRIPTOR_FIXTURES) {
      const result = normalizeDescriptor(fixture.raw);
      expect(result.tokens.join(' ')).toBe(result.normalized);
    }
  });

  it('returns the raw descriptor unmodified', () => {
    expect(normalizeDescriptor('  SPOTIFY   USA  ').raw).toBe('  SPOTIFY   USA  ');
  });

  it('handles an empty descriptor without throwing', () => {
    const result = normalizeDescriptor('');
    expect(result).toMatchObject({ normalized: '', channel: 'direct', tokens: [], tokenSpans: [] });
  });

  it('keeps offsets aligned through characters that uppercase to two (ß)', () => {
    const result = normalizeDescriptor('straße spotify');
    expect(result.normalized).toBe('STRA E SPOTIFY');
    const first = result.tokenSpans[0];
    expect('straße spotify'.slice(first?.start ?? 0, first?.end ?? 0)).toBe('stra');
  });
});

// ── channel extraction ─────────────────────────────────────────────────────────────────

describe('billing channel extraction', () => {
  it('strips the PayPal marker but keeps the merchant behind it', () => {
    const result = normalizeDescriptor('PAYPAL *SPOTIFY');
    expect(result).toMatchObject({ normalized: 'SPOTIFY', channel: 'paypal' });
    expect(result.strippedSpans[0]).toMatchObject({ start: 0, reason: 'channel' });
  });

  it('falls back to the marker when Apple named no merchant at all', () => {
    const result = normalizeDescriptor('APPLE.COM/BILL 866-712-7753 CA');
    expect(result).toMatchObject({ normalized: 'APPLE', channel: 'apple', tokens: ['APPLE'] });
    // The highlight points at the marker, so the decoder still has something real to show.
    expect(result.tokenSpans[0]).toEqual({ start: 0, end: 14 });
  });

  it('takes the leftmost marker when a descriptor carries two', () => {
    // A bank prefix in front of an intermediary in front of a merchant: PayPal took the money.
    expect(normalizeDescriptor('CHKCARD PAYPAL *SPOTIFY').channel).toBe('paypal');
  });

  it('does not invent a channel from a merchant name that merely resembles one', () => {
    expect(normalizeDescriptor('APPLE TV+').channel).toBe('direct');
    expect(normalizeDescriptor('MICROSOFT 365 FAMILY').channel).toBe('direct');
    expect(normalizeDescriptor('XBOX GAME PASS ULTIMATE').channel).toBe('direct');
  });

  it('reports an empty key when nothing identifying survived', () => {
    expect(normalizeDescriptor('SP *1234567').normalized).toBe('');
    expect(normalizeDescriptor('POS DEBIT 00123456789').normalized).toBe('');
  });
});

describe('normalizedKeyOf', () => {
  it('returns just the key', () => {
    expect(normalizedKeyOf('Netflix.com Los Gatos CA')).toBe('NETFLIX');
  });
});

// ── trigram similarity ─────────────────────────────────────────────────────────────────

describe('trigramSimilarity', () => {
  it('is 1 for identical strings', () => {
    expect(trigramSimilarity('NETFLIX', 'NETFLIX')).toBe(1);
    expect(trigramSimilarity('', '')).toBe(1);
  });

  it('is 0 for strings with no shared trigram', () => {
    expect(trigramSimilarity('NETFLIX', 'SPOTIFY')).toBe(0);
  });

  it('is 0 when either side is too short to have a trigram', () => {
    expect(trigramSimilarity('AB', 'NETFLIX')).toBe(0);
    expect(trigramSimilarity('NETFLIX', '')).toBe(0);
  });

  it('is symmetric', () => {
    expect(trigramSimilarity('DISNEY PLUS', 'DISNEY PLUSS')).toBe(
      trigramSimilarity('DISNEY PLUSS', 'DISNEY PLUS'),
    );
  });

  it('is case-insensitive', () => {
    expect(trigramSimilarity('netflix', 'NETFLIX')).toBe(1);
  });

  it('scores a bank truncation high enough to match', () => {
    // 19-character truncation of a 20-character name — the single most common fuzzy case.
    expect(trigramSimilarity('ADOBE CREATIVE CLOU', 'ADOBE CREATIVE CLOUD')).toBeGreaterThan(
      DEFAULT_TRIGRAM_THRESHOLD,
    );
  });

  it('scores a two-character suffix below the threshold', () => {
    const score = trigramSimilarity('DISNEY PLUSHD', 'DISNEY PLUS');
    expect(score).toBeGreaterThan(0.8);
    expect(score).toBeLessThan(DEFAULT_TRIGRAM_THRESHOLD);
  });
});

// ── merchant matching ──────────────────────────────────────────────────────────────────

function entry(
  id: string,
  name: string,
  aliases: string[],
  descriptorPatterns: string[],
  category: Category = 'streaming_video',
  typicalIntervals: RecurrenceInterval[] = [MONTHLY],
): MerchantRegistryEntry {
  return { id, name, aliases, descriptorPatterns, typicalIntervals, category };
}

const REGISTRY = createInMemoryRegistry([
  entry('netflix', 'Netflix', ['Netflix Inc'], ['NETFLIX.COM']),
  entry('spotify', 'Spotify', ['Spotify'], ['SPOTIFY USA'], 'music_audio'),
  entry('hbo-max', 'HBO Max', ['HBO', 'HBO MAX'], ['HBO MAX']),
  entry('adobe-cc', 'Adobe Creative Cloud', [], ['ADOBE CREATIVE CLOUD'], 'design'),
  entry('disney-plus', 'Disney Plus', [], ['DISNEY PLUS']),
]);

describe('matchMerchant', () => {
  it('matches an exact descriptor pattern with full confidence', () => {
    const match = matchMerchant(normalizeDescriptor('Netflix.com Los Gatos CA'), REGISTRY);
    expect(match).toEqual({
      merchantId: 'netflix',
      matchedVia: 'exact',
      score: 1,
      matchedSpan: { start: 0, end: 7 },
    });
  });

  it('matches an exact pattern regardless of which descriptor shape produced the key', () => {
    for (const raw of ['NETFLIX 866-579-7172 CA', 'PAYPAL *NETFLIX', 'DD NETFLIX.COM', 'netflix']) {
      expect(matchMerchant(normalizeDescriptor(raw), REGISTRY).merchantId).toBe('netflix');
    }
  });

  it('matches an alias embedded in a longer key, and highlights only the alias', () => {
    const descriptor = normalizeDescriptor('SPOTIFY FAMILY PLAN');
    const match = matchMerchant(descriptor, REGISTRY);
    expect(match.merchantId).toBe('spotify');
    expect(match.matchedVia).toBe('alias');
    expect(match.matchedSpan).toEqual({ start: 0, end: 7 });
    // Alias hits sit between the trigram floor and an exact hit, scaled by coverage.
    expect(match.score).toBeGreaterThan(DEFAULT_TRIGRAM_THRESHOLD);
    expect(match.score).toBeLessThan(1);
  });

  it('scores a fully covering alias above a partially covering one', () => {
    const whole = matchMerchant(normalizeDescriptor('PAYPAL *SPOTIFY'), REGISTRY);
    const partial = matchMerchant(normalizeDescriptor('SPOTIFY FAMILY PLAN'), REGISTRY);
    expect(whole.score).toBeGreaterThan(partial.score);
  });

  it('prefers the longest alias when several match', () => {
    const descriptor = normalizeDescriptor('HBO MAX ORIGINALS');
    const match = matchMerchant(descriptor, REGISTRY);
    expect(match.matchedVia).toBe('alias');
    // `HBO` also matches; the span proves the two-token alias won.
    expect(match.matchedSpan).toEqual({ start: 0, end: 7 });
  });

  it('falls back to trigram similarity for a truncated descriptor', () => {
    const match = matchMerchant(normalizeDescriptor('ADOBE CREATIVE CLOU'), REGISTRY);
    expect(match.merchantId).toBe('adobe-cc');
    expect(match.matchedVia).toBe('trigram');
    expect(match.score).toBeGreaterThanOrEqual(DEFAULT_TRIGRAM_THRESHOLD);
    expect(match.matchedSpan).toEqual({ start: 0, end: 19 });
  });

  it('refuses a 0.81 trigram score', () => {
    const descriptor = normalizeDescriptor('DISNEY PLUSHD');
    // The nearest registry entry is `DISNEY PLUS`, and it is close — just not close enough.
    expect(trigramSimilarity(descriptor.normalized, 'DISNEY PLUS')).toBeLessThan(
      DEFAULT_TRIGRAM_THRESHOLD,
    );
    expect(matchMerchant(descriptor, REGISTRY)).toEqual({
      merchantId: null,
      matchedVia: 'none',
      score: 0,
    });
  });

  it('accepts that same score when the caller lowers the threshold', () => {
    const match = matchMerchant(normalizeDescriptor('DISNEY PLUSHD'), REGISTRY, 0.8);
    expect(match).toMatchObject({ merchantId: 'disney-plus', matchedVia: 'trigram' });
  });

  it('returns no match for an unrelated merchant', () => {
    const match = matchMerchant(normalizeDescriptor('WHOLE FOODS MKT 10123 AUSTIN TX'), REGISTRY);
    expect(match).toEqual({ merchantId: null, matchedVia: 'none', score: 0 });
    expect(match.matchedSpan).toBeUndefined();
  });

  it('returns no match for an empty key rather than matching everything', () => {
    expect(matchMerchant(normalizeDescriptor('SP *1234567'), REGISTRY).matchedVia).toBe('none');
  });

  it('does not attach a merchant to the whole App Store just because Apple billed it', () => {
    expect(
      matchMerchant(normalizeDescriptor('APPLE.COM/BILL 866-712-7753 CA'), REGISTRY).merchantId,
    ).toBe(null);
  });
});

describe('createInMemoryRegistry', () => {
  it('looks up by the normalized form of the descriptor pattern', () => {
    expect(REGISTRY.byExactPattern('NETFLIX')?.id).toBe('netflix');
    expect(REGISTRY.byExactPattern('NETFLIX.COM')).toBe(null);
    expect(REGISTRY.byExactPattern('NOT A MERCHANT')).toBe(null);
  });

  it('lets the first registration of a pattern keep it', () => {
    const registry = createInMemoryRegistry([
      entry('first', 'First', [], ['SHARED PATTERN']),
      entry('second', 'Second', [], ['SHARED PATTERN']),
    ]);
    expect(registry.byExactPattern('SHARED PATTERN')?.id).toBe('first');
  });

  it('ignores patterns that normalize to nothing', () => {
    const registry = createInMemoryRegistry([entry('junk', 'Junk', [], ['00123456789'])]);
    expect(registry.byExactPattern('')).toBe(null);
    expect(registry.all()).toHaveLength(1);
  });
});
