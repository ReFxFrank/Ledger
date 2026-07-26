/**
 * The shipped dataset, not a fixture.
 *
 * `load.test.ts` pins the loader's behaviour against synthetic files; this file pins the data
 * itself. The distinction matters because every rule below can be satisfied by a schema that is
 * subtly wrong — the store-host rule in particular is re-declared here rather than imported, so
 * that loosening `STORE_CANCEL_HOSTS` in schema.ts breaks this test instead of being blessed by
 * it. A dataset error surfaces months later as a support ticket, by which point a user has
 * already been sent to a cancel button that cannot cancel their subscription (brief §3.1).
 */

import { BILLING_CHANNELS, INTERMEDIATED_CHANNELS, plainDate } from '@ledger/core';
import { describe, expect, it } from 'vitest';
import { auditPlaybooks } from './audit';
import {
  MERCHANT_DATA_DIR,
  buildRegistry,
  findPlaybook,
  loadMerchants,
  validateMerchantDir,
} from './load';
import { normalizeDescriptorKey } from './schema';
import type { BillingChannel } from '@ledger/core';
import type { Playbook } from './schema';

/** Brief §10.1. Below this the dataset has too many holes to be worth shipping. */
/**
 * The brief's floor is 120. This sits just under what actually ships (141) rather than at the
 * contractual minimum, because a floor 21 files below the dataset would let a seventh of the
 * merchant registry disappear — a bad merge, a deleted directory — without CI noticing. The
 * small gap is room to retire an entry that turns out to be wrong; anything larger than that is
 * a regression, and this is where it gets caught.
 */
const MINIMUM_MERCHANTS = 135;

/**
 * The date the dataset was last swept. It moves when the dataset is re-verified, and it is a
 * fixed value rather than the wall clock so a passing test stays passing tomorrow.
 */
const AS_OF = plainDate(2026, 7, 25);

// Read once: a few hundred files, and nothing here mutates them.
const merchants = loadMerchants();
const registry = buildRegistry(merchants);

interface PlaybookRef {
  readonly slug: string;
  readonly playbook: Playbook;
}

const allPlaybooks: PlaybookRef[] = merchants.flatMap((merchant) =>
  merchant.playbooks.map((playbook) => ({ slug: merchant.slug, playbook })),
);

function label(ref: PlaybookRef): string {
  return `${ref.slug}/${ref.playbook.channel}`;
}

describe('the shipped merchant dataset', () => {
  it('loads and validates in full', () => {
    const validation = validateMerchantDir(MERCHANT_DATA_DIR);
    // Named files rather than a boolean: a failure should say which file and why, without a rerun.
    expect(
      validation.files.flatMap((file) =>
        file.errors.map((error) => `${file.displayPath} -> ${error}`),
      ),
    ).toEqual([]);
    expect(validation.crossFileErrors).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it(`covers at least ${String(MINIMUM_MERCHANTS)} merchants`, () => {
    expect(merchants.length).toBeGreaterThanOrEqual(MINIMUM_MERCHANTS);
  });

  it('gives every merchant at least one playbook', () => {
    const empty = merchants.filter((merchant) => merchant.playbooks.length === 0);
    expect(empty.map((merchant) => merchant.slug)).toEqual([]);
  });

  it('gives every merchant at least one descriptor fragment', () => {
    const unmatched = merchants.filter((merchant) => merchant.descriptorPatterns.length === 0);
    expect(unmatched.map((merchant) => merchant.slug)).toEqual([]);
  });

  it('sources and dates every playbook', () => {
    const unsourced = allPlaybooks.filter(
      (ref) => ref.playbook.sourceUrl.trim() === '' || ref.playbook.lastVerifiedAt.trim() === '',
    );
    expect(unsourced.map(label)).toEqual([]);
  });

  it('carries no playbook that the audit would call stale or future-dated', () => {
    const report = auditPlaybooks(merchants, { today: AS_OF });
    expect(report.totalPlaybooks).toBe(allPlaybooks.length);
    // A year typed as 2027 would never go stale, so the audit would stay silent about it forever.
    expect(report.futureDated.map((entry) => `${entry.slug}/${entry.channel}`)).toEqual([]);
    expect(report.stale.map((entry) => `${entry.slug}/${entry.channel}`)).toEqual([]);
  });

  it('uses only channels @ledger/core knows about', () => {
    const known = new Set<string>(BILLING_CHANNELS);
    expect(allPlaybooks.filter((ref) => !known.has(ref.playbook.channel)).map(label)).toEqual([]);
  });
});

describe('the store-cancellation rule, across the whole dataset', () => {
  /**
   * Deliberately duplicated from schema.ts rather than imported. `carrier` is absent because the
   * biller differs per user, so no URL in a merchant file can be right for all of them.
   */
  const STORE_HOSTS: Readonly<Partial<Record<BillingChannel, readonly string[]>>> = {
    apple: ['apple.com'],
    google: ['play.google.com'],
    amazon: ['amazon.com'],
    roku: ['roku.com'],
    microsoft: ['microsoft.com'],
  };

  it('never sends a store-billed playbook to the provider site', () => {
    const offenders: string[] = [];

    for (const ref of allPlaybooks) {
      const { channel, cancelUrl } = ref.playbook;
      if (!INTERMEDIATED_CHANNELS.includes(channel) || cancelUrl === undefined) continue;

      const allowed = STORE_HOSTS[channel] ?? [];
      const host = new URL(cancelUrl).hostname.toLowerCase();
      const ok = allowed.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
      if (!ok) offenders.push(`${label(ref)} -> ${cancelUrl}`);
    }

    expect(offenders).toEqual([]);
  });

  it('has enough store-billed playbooks for that rule to mean something', () => {
    const intermediated = allPlaybooks.filter((ref) =>
      INTERMEDIATED_CHANNELS.includes(ref.playbook.channel),
    );
    expect(intermediated.length).toBeGreaterThan(50);
  });

  it('leaves carrier playbooks without a cancelUrl', () => {
    const withUrl = allPlaybooks.filter(
      (ref) => ref.playbook.channel === 'carrier' && ref.playbook.cancelUrl !== undefined,
    );
    expect(withUrl.map(label)).toEqual([]);
  });

  /**
   * The same invariant said without the host allowlist: a store-billed playbook must not link to
   * a domain the merchant owns. Three merchants are the store — Apple sells Apple Arcade through
   * the App Store — so for them the two are the same domain and the exception is legitimate.
   * Listing them by name means a fourth one has to be argued for rather than absorbed.
   */
  const MERCHANTS_THAT_ARE_THE_STORE = new Set([
    'apple-arcade',
    'google-play-pass',
    'microsoft-365',
  ]);

  it('never sends a store-billed playbook to a domain the merchant itself owns', () => {
    const offenders: string[] = [];

    for (const merchant of merchants) {
      if (MERCHANTS_THAT_ARE_THE_STORE.has(merchant.slug)) continue;

      for (const playbook of merchant.playbooks) {
        if (!INTERMEDIATED_CHANNELS.includes(playbook.channel)) continue;
        if (playbook.cancelUrl === undefined) continue;

        const host = new URL(playbook.cancelUrl).hostname.toLowerCase();
        const own = merchant.domains.some(
          (domain) => host === domain || host.endsWith(`.${domain}`),
        );
        if (own) offenders.push(`${merchant.slug}/${playbook.channel} -> ${host}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps that carve-out to merchants that really are the store', () => {
    const stillPresent = [...MERCHANTS_THAT_ARE_THE_STORE].filter(
      (slug) => registry.bySlug(slug) === null,
    );
    expect(stillPresent).toEqual([]);
  });
});

describe('findPlaybook against real merchants', () => {
  it('never substitutes the direct playbook for a missing store playbook', () => {
    for (const channel of INTERMEDIATED_CHANNELS) {
      // The whole dataset, not one sample: a merchant that gains a store playbook later simply
      // drops out of this list rather than making the test stale.
      const leaked = merchants
        .filter((merchant) => !merchant.playbooks.some((p) => p.channel === channel))
        .filter((merchant) => findPlaybook(merchant, channel) !== null);
      expect(leaked.map((merchant) => merchant.slug)).toEqual([]);
    }
  });

  it('returns null for apple on a merchant that has no apple playbook', () => {
    const withoutApple = merchants.find(
      (merchant) =>
        !merchant.playbooks.some((p) => p.channel === 'apple') &&
        merchant.playbooks.some((p) => p.channel === 'direct'),
    );
    if (withoutApple === undefined) throw new Error('dataset has no apple-less merchant to test');

    expect(findPlaybook(withoutApple, 'apple')).toBeNull();
    // Same merchant, a channel the provider can still cancel: falling back is correct there.
    expect(findPlaybook(withoutApple, 'paypal')?.channel).toBe('direct');
  });

  it('returns the store playbook when the merchant has one', () => {
    const netflix = registry.bySlug('netflix');
    if (netflix === null) throw new Error('netflix is missing from the dataset');
    expect(findPlaybook(netflix, 'apple')?.channel).toBe('apple');
    expect(findPlaybook(netflix, 'google')?.channel).toBe('google');
    expect(findPlaybook(netflix, 'direct')?.channel).toBe('direct');
  });
});

describe('descriptor lookup', () => {
  const cases: [descriptor: string, slug: string][] = [
    ['NETFLIX.COM', 'netflix'],
    ['SPOTIFY USA', 'spotify'],
    ['DISNEYPLUS.COM', 'disney-plus'],
    ['HBO MAX', 'hbo-max'],
    ['NYTIMES.COM', 'new-york-times'],
    ['AGILEBITS', '1password'],
    ['PATREON.COM', 'patreon'],
  ];

  it.each(cases)('resolves %s to %s', (descriptor, slug) => {
    expect(registry.byExactPattern(descriptor)?.slug).toBe(slug);
  });

  it('normalizes whatever the caller passes in', () => {
    expect(registry.byExactPattern('  netflix.com ')?.slug).toBe('netflix');
    expect(registry.byExactPattern('spotify   usa')?.slug).toBe('spotify');
  });

  it('invents no match for a descriptor nobody claims', () => {
    expect(registry.byExactPattern('SOME MERCHANT THAT IS NOT HERE')).toBeNull();
  });

  it('gives each descriptor fragment exactly one owner', () => {
    const owners = new Map<string, string>();
    const collisions: string[] = [];

    for (const merchant of merchants) {
      for (const pattern of merchant.descriptorPatterns) {
        const key = normalizeDescriptorKey(pattern);
        const owner = owners.get(key);
        if (owner !== undefined && owner !== merchant.slug) {
          collisions.push(`"${key}" claimed by ${owner} and ${merchant.slug}`);
          continue;
        }
        owners.set(key, merchant.slug);
      }
    }

    expect(collisions).toEqual([]);
  });

  it('routes every fragment back to the merchant that declared it', () => {
    const misrouted = merchants.flatMap((merchant) =>
      merchant.descriptorPatterns
        .filter((pattern) => registry.byExactPattern(pattern)?.slug !== merchant.slug)
        .map((pattern) => `${merchant.slug}: ${pattern}`),
    );
    expect(misrouted).toEqual([]);
  });

  it('routes every slug and alias back to the merchant that declared it', () => {
    const misrouted = merchants.flatMap((merchant) =>
      [merchant.slug, ...merchant.aliases]
        .filter((alias) => registry.byAlias(alias)?.slug !== merchant.slug)
        .map((alias) => `${merchant.slug}: ${alias}`),
    );
    expect(misrouted).toEqual([]);
  });
});

describe('cross-file references', () => {
  it('points every supersededBy at a merchant that exists', () => {
    const dangling = merchants
      .filter((merchant) => merchant.supersededBy !== undefined)
      .filter((merchant) => registry.bySlug(merchant.supersededBy ?? '') === null)
      .map((merchant) => `${merchant.slug} -> ${merchant.supersededBy ?? ''}`);
    expect(dangling).toEqual([]);
  });

  it('registers every merchant exactly once', () => {
    const slugs = merchants.map((merchant) => merchant.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(registry.all()).toHaveLength(merchants.length);
  });
});
