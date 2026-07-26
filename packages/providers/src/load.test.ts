/**
 * Loader, registry, and routing. `findPlaybook` is the highest-stakes function in the package:
 * returning a `direct` playbook for an App Store subscription would send a user to a cancel
 * button that cannot cancel their subscription, so its fallback rules are pinned here.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plainDate } from '@ledger/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditPlaybooks } from './audit';
import {
  MERCHANT_DATA_DIR,
  MerchantDatasetError,
  buildRegistry,
  findPlaybook,
  loadMerchants,
  validateMerchantDir,
} from './load';
import type { MerchantFile } from './schema';

const TODAY = plainDate(2026, 7, 25);

function merchantYaml(slug: string, extra = ''): string {
  return [
    `slug: ${slug}`,
    `name: ${slug}`,
    'category: streaming_video',
    `descriptorPatterns:`,
    `  - ${slug.toUpperCase().replace(/-/g, ' ')}`,
    'playbooks:',
    '  - channel: direct',
    '    method: account_settings',
    '    difficulty: 2',
    '    steps:',
    '      - text: Open Account, then Membership, then Cancel.',
    '    sourceUrl: https://help.example.com/cancel',
    '    lastVerifiedAt: "2026-07-01"',
    extra,
  ].join('\n');
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-providers-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(relativePath: string, contents: string): void {
  const full = join(dir, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents, 'utf8');
}

describe('loadMerchants', () => {
  it('reads nested directories and ignores files that start with an underscore', () => {
    write('streaming/one.yaml', merchantYaml('one'));
    write('music/two.yaml', merchantYaml('two'));
    write('_TEMPLATE.yaml', merchantYaml('template-example'));

    const merchants = loadMerchants(dir);
    expect(merchants.map((m) => m.slug)).toEqual(['two', 'one']);
  });

  it('still validates template files', () => {
    write('_TEMPLATE.yaml', 'slug: Not Kebab\n');
    const validation = validateMerchantDir(dir);
    expect(validation.ok).toBe(false);
    expect(validation.files[0]?.isTemplate).toBe(true);
  });

  it('reports every failure at once, attributed to its file', () => {
    write('good.yaml', merchantYaml('good'));
    write('bad-a.yaml', 'slug: BAD\nname: Bad\n');
    write('bad-b.yaml', 'slug: also-bad\n');

    let problems: readonly string[] = [];
    try {
      loadMerchants(dir);
    } catch (error) {
      if (!(error instanceof MerchantDatasetError)) throw error;
      problems = error.problems;
    }

    expect(problems.some((p) => p.startsWith('bad-a.yaml →'))).toBe(true);
    expect(problems.some((p) => p.startsWith('bad-b.yaml →'))).toBe(true);
    expect(problems.some((p) => p.startsWith('good.yaml'))).toBe(false);
  });

  it('reports unreadable YAML rather than throwing out of the parser', () => {
    write('broken.yaml', 'slug: one\nplaybooks:\n\t- channel: direct\n');
    const validation = validateMerchantDir(dir);
    expect(validation.ok).toBe(false);
    expect(validation.files[0]?.errors.join(' ')).toMatch(/unreadable YAML/);
  });

  it('reports an empty file', () => {
    write('empty.yaml', '# nothing but a comment\n');
    expect(validateMerchantDir(dir).files[0]?.errors).toEqual(['file is empty']);
  });

  it('catches duplicate slugs and colliding descriptor fragments across files', () => {
    write('a.yaml', merchantYaml('one'));
    write('b.yaml', merchantYaml('one'));
    expect(validateMerchantDir(dir).crossFileErrors.join(' ')).toMatch(/duplicate slug "one"/);

    rmSync(join(dir, 'b.yaml'));
    write('c.yaml', merchantYaml('two').replace('  - TWO', '  - ONE'));
    expect(validateMerchantDir(dir).crossFileErrors.join(' ')).toMatch(
      /descriptor fragment "ONE" is claimed by both/,
    );
  });

  it('catches a supersededBy that points nowhere', () => {
    write('a.yaml', `${merchantYaml('one')}\nsupersededBy: nowhere\n`);
    expect(validateMerchantDir(dir).crossFileErrors.join(' ')).toMatch(/not in the dataset/);
  });

  it('accepts the shipped dataset directory', () => {
    // Asserts the default path resolves and that every shipped file validates — including
    // `_TEMPLATE.yaml`, which stays in the set deliberately: every new merchant is copied from
    // it, so a template that has drifted out of schema propagates into whatever is written next.
    const validation = validateMerchantDir(MERCHANT_DATA_DIR);
    expect(validation.files.map((f) => f.displayPath)).toContain('_TEMPLATE.yaml');
    expect(validation.files.flatMap((f) => f.errors)).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});

describe('buildRegistry', () => {
  function fixtures(): MerchantFile[] {
    write('a.yaml', `${merchantYaml('example-merchant')}\naliases:\n  - Example TV\n`);
    write('b.yaml', merchantYaml('other-merchant'));
    return loadMerchants(dir);
  }

  it('looks up by exact normalized descriptor fragment', () => {
    const registry = buildRegistry(fixtures());
    expect(registry.byExactPattern('EXAMPLE MERCHANT')?.slug).toBe('example-merchant');
    // Callers may hand over raw descriptor text; the registry normalizes it.
    expect(registry.byExactPattern('  example   merchant ')?.slug).toBe('example-merchant');
    expect(registry.byExactPattern('EXAMPLE')).toBeNull();
  });

  it('looks up by alias and by slug', () => {
    const registry = buildRegistry(fixtures());
    expect(registry.byAlias('example tv')?.slug).toBe('example-merchant');
    expect(registry.byAlias('Example TV')?.slug).toBe('example-merchant');
    expect(registry.byAlias('example-merchant')?.slug).toBe('example-merchant');
    expect(registry.byAlias('unknown')).toBeNull();
    expect(registry.bySlug('other-merchant')?.slug).toBe('other-merchant');
  });

  it('all() returns every merchant and cannot be mutated through', () => {
    const registry = buildRegistry(fixtures());
    const all = registry.all();
    expect(all).toHaveLength(2);
    all.pop();
    expect(registry.all()).toHaveLength(2);
  });

  it('refuses to build when two merchants claim the same fragment', () => {
    write('a.yaml', merchantYaml('one'));
    write('b.yaml', merchantYaml('two').replace('  - TWO', '  - ONE'));
    const merchants = validateMerchantDir(dir).files.flatMap((f) =>
      f.merchant === null ? [] : [f.merchant],
    );
    expect(() => buildRegistry(merchants)).toThrow(MerchantDatasetError);
  });
});

describe('findPlaybook', () => {
  function merchantWith(channels: readonly string[]): MerchantFile {
    const playbooks = channels
      .map((channel) =>
        [
          `  - channel: ${channel}`,
          `    method: ${channel === 'direct' || channel === 'paypal' ? 'account_settings' : 'app_store'}`,
          '    difficulty: 1',
          '    steps:',
          `      - text: Cancel from ${channel}.`,
          '    sourceUrl: https://help.example.com/cancel',
          '    lastVerifiedAt: "2026-07-01"',
        ].join('\n'),
      )
      .join('\n');
    write(
      'm.yaml',
      [
        'slug: m',
        'name: M',
        'category: software',
        'descriptorPatterns:',
        '  - M SUB',
        'playbooks:',
        playbooks,
      ].join('\n'),
    );
    const merchant = loadMerchants(dir)[0];
    if (merchant === undefined) throw new Error('fixture did not load');
    return merchant;
  }

  it('returns the playbook for the exact channel when one exists', () => {
    const merchant = merchantWith(['direct', 'apple']);
    expect(findPlaybook(merchant, 'apple')?.channel).toBe('apple');
    expect(findPlaybook(merchant, 'direct')?.channel).toBe('direct');
  });

  it('NEVER falls back to direct for a store-billed channel', () => {
    const merchant = merchantWith(['direct']);
    for (const channel of ['apple', 'google', 'amazon', 'roku', 'microsoft', 'carrier'] as const) {
      expect(findPlaybook(merchant, channel)).toBeNull();
    }
  });

  it('falls back to direct for channels the provider can still cancel', () => {
    const merchant = merchantWith(['direct']);
    expect(findPlaybook(merchant, 'paypal')?.channel).toBe('direct');
    expect(findPlaybook(merchant, 'steam')?.channel).toBe('direct');
    expect(findPlaybook(merchant, 'unknown')?.channel).toBe('direct');
  });

  it('returns null when there is nothing to fall back to', () => {
    const merchant = merchantWith(['apple']);
    expect(findPlaybook(merchant, 'paypal')).toBeNull();
  });
});

describe('auditPlaybooks', () => {
  function datedMerchants(dates: readonly string[]): MerchantFile[] {
    dates.forEach((date, index) => {
      write(
        `m${String(index)}.yaml`,
        merchantYaml(`m-${String(index)}`).replace('2026-07-01', date),
      );
    });
    return loadMerchants(dir);
  }

  it('lists playbooks older than the threshold, oldest first', () => {
    const merchants = datedMerchants(['2026-07-01', '2025-01-01', '2025-12-01']);
    const report = auditPlaybooks(merchants, { today: TODAY });

    expect(report.totalPlaybooks).toBe(3);
    expect(report.thresholdDays).toBe(180);
    expect(report.stale.map((entry) => entry.lastVerifiedAt)).toEqual(['2025-01-01', '2025-12-01']);
    expect(report.stale[0]?.daysSinceVerified).toBe(570);
  });

  it('treats the threshold day itself as fresh and the day before it as stale', () => {
    expect(auditPlaybooks(datedMerchants(['2026-01-26']), { today: TODAY }).stale).toEqual([]);
    expect(auditPlaybooks(datedMerchants(['2026-01-25']), { today: TODAY }).stale).toHaveLength(1);
  });

  it('flags a verification date in the future, which would otherwise never go stale', () => {
    const report = auditPlaybooks(datedMerchants(['2027-07-01']), { today: TODAY });
    expect(report.futureDated.map((entry) => entry.slug)).toEqual(['m-0']);
    expect(report.stale).toEqual([]);
  });
});
