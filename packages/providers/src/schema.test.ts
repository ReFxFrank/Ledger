/**
 * The schema is the only thing standing between a well-meaning contributor and a user being
 * shown a cancel button that cannot cancel anything, so every refinement gets both a case that
 * must pass and a case that must fail. The two that matter most are the App Store channel rule
 * and the legal-claim guard.
 */

import { describe, expect, it } from 'vitest';
import { merchantFileSchema } from './schema';

const DIRECT_PLAYBOOK: Record<string, unknown> = {
  channel: 'direct',
  method: 'account_settings',
  difficulty: 2,
  steps: [{ text: 'Open Account, then Membership, then Cancel Membership.' }],
  sourceUrl: 'https://help.example.com/en/article/cancel',
  lastVerifiedAt: '2026-07-25',
};

function merchant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'example-merchant',
    name: 'Example Merchant',
    category: 'streaming_video',
    domains: ['example.com'],
    aliases: ['Example'],
    descriptorPatterns: ['EXAMPLE MERCHANT'],
    typicalIntervals: [{ unit: 'month', count: 1 }],
    playbooks: [DIRECT_PLAYBOOK],
    ...overrides,
  };
}

/** A merchant whose single playbook is the direct one with `overrides` applied. */
function withPlaybook(overrides: Record<string, unknown>): Record<string, unknown> {
  return merchant({ playbooks: [{ ...DIRECT_PLAYBOOK, ...overrides }] });
}

function issues(input: unknown): string[] {
  const result = merchantFileSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

function expectAccepted(input: unknown): void {
  expect(issues(input)).toEqual([]);
}

/** Also asserts rejection: an accepted input joins to the empty string and matches nothing. */
function expectRejected(input: unknown, matcher: RegExp): void {
  expect(issues(input).join(' | ')).toMatch(matcher);
}

describe('merchantFileSchema — shape', () => {
  it('accepts a minimal merchant', () => {
    expectAccepted(merchant());
  });

  it('rejects a slug that is not kebab-case', () => {
    expectRejected(merchant({ slug: 'Example_Merchant' }), /slug.*kebab-case/);
  });

  it('rejects an unknown category', () => {
    expectRejected(merchant({ category: 'streaming' }), /category/);
  });

  it('rejects unknown keys so a typo cannot be silently ignored', () => {
    expectRejected(merchant({ cancelUrl: 'https://example.com' }), /[Uu]nrecognized key/);
  });

  it('rejects a merchant with no descriptor patterns', () => {
    expectRejected(merchant({ descriptorPatterns: [] }), /descriptorPatterns/);
  });

  it('rejects descriptor fragments that are not in normalized form', () => {
    expectRejected(merchant({ descriptorPatterns: ['example merchant'] }), /normalized form/);
    expectRejected(merchant({ descriptorPatterns: ['EXAMPLE  MERCHANT'] }), /normalized form/);
    expectRejected(merchant({ descriptorPatterns: [' EXAMPLE MERCHANT'] }), /normalized form/);
  });

  it('rejects duplicate descriptor fragments within one file', () => {
    expectRejected(
      merchant({ descriptorPatterns: ['EXAMPLE MERCHANT', 'EXAMPLE MERCHANT'] }),
      /duplicate descriptor fragment/,
    );
  });

  it('rejects a merchant that supersedes itself', () => {
    expectRejected(merchant({ supersededBy: 'example-merchant' }), /cannot supersede itself/);
    expectAccepted(merchant({ supersededBy: 'example-merchant-2' }));
  });

  it('requires at least one playbook, and at most one per channel', () => {
    expectRejected(merchant({ playbooks: [] }), /at least one playbook/);
    expectRejected(
      merchant({ playbooks: [DIRECT_PLAYBOOK, { ...DIRECT_PLAYBOOK, difficulty: 3 }] }),
      /duplicate playbook for channel "direct"/,
    );
  });

  it('requires at least one step', () => {
    expectRejected(withPlaybook({ steps: [] }), /no steps/);
  });
});

describe('merchantFileSchema — provenance', () => {
  it('requires sourceUrl and lastVerifiedAt on every playbook', () => {
    const { sourceUrl: _sourceUrl, ...noSource } = DIRECT_PLAYBOOK;
    expectRejected(merchant({ playbooks: [noSource] }), /sourceUrl/);

    const { lastVerifiedAt: _verified, ...noDate } = DIRECT_PLAYBOOK;
    expectRejected(merchant({ playbooks: [noDate] }), /lastVerifiedAt/);
  });

  it('rejects a non-https source', () => {
    expectRejected(withPlaybook({ sourceUrl: 'http://help.example.com/cancel' }), /https/);
  });

  it('rejects a lastVerifiedAt that is not a real YYYY-MM-DD date', () => {
    expectRejected(withPlaybook({ lastVerifiedAt: '25/07/2026' }), /YYYY-MM-DD/);
    expectRejected(withPlaybook({ lastVerifiedAt: '2026-02-31' }), /real calendar date/);
    expectAccepted(withPlaybook({ lastVerifiedAt: '2024-02-29' }));
  });
});

describe('merchantFileSchema — the channel rule (brief §3.1)', () => {
  it("REJECTS an apple playbook pointing at the provider's own cancel page", () => {
    expectRejected(
      withPlaybook({
        channel: 'apple',
        method: 'app_store',
        cancelUrl: 'https://example.com/account/cancel',
      }),
      /cancels inside the store's own settings/,
    );
  });

  it('accepts an apple playbook with no cancelUrl, or one at the App Store', () => {
    expectAccepted(withPlaybook({ channel: 'apple', method: 'app_store' }));
    expectAccepted(
      withPlaybook({
        channel: 'apple',
        method: 'app_store',
        cancelUrl: 'https://apps.apple.com/account/subscriptions',
      }),
    );
  });

  it('holds for the other intermediated channels', () => {
    expectAccepted(
      withPlaybook({
        channel: 'google',
        method: 'app_store',
        cancelUrl: 'https://play.google.com/store/account/subscriptions',
      }),
    );
    // google.com is not play.google.com — the store, not the parent company.
    expectRejected(
      withPlaybook({ channel: 'google', method: 'app_store', cancelUrl: 'https://google.com/x' }),
      /cancelUrl/,
    );
    expectAccepted(
      withPlaybook({
        channel: 'roku',
        method: 'app_store',
        cancelUrl: 'https://my.roku.com/account/subscriptions',
      }),
    );
    expectRejected(
      withPlaybook({ channel: 'amazon', method: 'app_store', cancelUrl: 'https://example.com/x' }),
      /cancelUrl/,
    );
  });

  it('is not fooled by a lookalike host', () => {
    expectRejected(
      withPlaybook({
        channel: 'apple',
        method: 'app_store',
        cancelUrl: 'https://apple.com.cancel-service.example/go',
      }),
      /cancelUrl/,
    );
  });

  it('allows no cancelUrl at all on a carrier playbook — which carrier is unknowable here', () => {
    expectAccepted(withPlaybook({ channel: 'carrier', method: 'account_settings' }));
    expectRejected(
      withPlaybook({
        channel: 'carrier',
        method: 'account_settings',
        cancelUrl: 'https://example.com/account/cancel',
      }),
      /no cancelUrl can be right/,
    );
  });

  it('leaves non-intermediated channels alone', () => {
    expectAccepted(withPlaybook({ cancelUrl: 'https://example.com/account/cancel' }));
    expectAccepted(
      withPlaybook({ channel: 'paypal', cancelUrl: 'https://example.com/account/cancel' }),
    );
  });
});

describe('merchantFileSchema — method prerequisites', () => {
  it('allows app_store only on a store-billed channel', () => {
    expectAccepted(withPlaybook({ channel: 'amazon', method: 'app_store' }));
    expectRejected(withPlaybook({ method: 'app_store' }), /only makes sense on a store-billed/);
    expectRejected(
      withPlaybook({ channel: 'paypal', method: 'app_store' }),
      /only makes sense on a store-billed/,
    );
  });

  it('requires a phone number for the phone method', () => {
    expectRejected(withPlaybook({ method: 'phone' }), /requires a phone number/);
    expectAccepted(withPlaybook({ method: 'phone', phone: '+1-800-555-0100' }));
  });

  it('requires a letter template for the post method', () => {
    expectRejected(withPlaybook({ method: 'post' }), /requires a letterTemplate/);
    expectAccepted(
      withPlaybook({
        method: 'post',
        letterTemplate: 'I am writing to end my membership. Please confirm the closing date.',
      }),
    );
  });
});

describe('merchantFileSchema — difficulty', () => {
  it('rejects a difficulty outside 1..5', () => {
    expectRejected(withPlaybook({ difficulty: 6 }), /1 \(one click\) to 5/);
    expectRejected(withPlaybook({ difficulty: 0 }), /1 \(one click\) to 5/);
  });

  it('demands a gotcha once difficulty reaches 4', () => {
    expectRejected(withPlaybook({ difficulty: 4 }), /difficulty 4\+ needs at least one gotcha/);
    expectRejected(withPlaybook({ difficulty: 5 }), /difficulty 4\+ needs at least one gotcha/);
    expectAccepted(
      withPlaybook({ difficulty: 4, gotchas: ['Hold times run past 20 minutes at month end.'] }),
    );
    // Below 4, an empty gotcha list is the normal case.
    expectAccepted(withPlaybook({ difficulty: 3 }));
  });
});

describe('merchantFileSchema — no legal claims (docs/legal-notes.md)', () => {
  it('REJECTS a legal claim in a step', () => {
    expectRejected(
      withPlaybook({ steps: [{ text: 'You have the right to cancel at any time.' }] }),
      /legal claim "You have the right"/,
    );
    expectRejected(
      withPlaybook({
        steps: [{ text: 'Call support.', detail: 'They are legally required to agree.' }],
      }),
      /legal claim/,
    );
    expectRejected(
      withPlaybook({ steps: [{ text: 'Email support.', warning: 'We will cancel it for you.' }] }),
      /legal claim/,
    );
  });

  it('rejects a legal claim in a gotcha, a note, or a refund policy', () => {
    expectRejected(
      withPlaybook({ gotchas: ['Guaranteed refund if you call within 14 days.'] }),
      /legal claim/,
    );
    expectRejected(
      merchant({ notes: 'The law requires them to offer a web cancellation.' }),
      /legal claim/,
    );
    expectRejected(
      withPlaybook({ refundPolicy: 'Guaranteed refund on annual plans.' }),
      /legal claim/,
    );
  });

  it('accepts the same facts stated as provider behaviour', () => {
    expectAccepted(
      merchant({
        notes: 'Support has offered refunds on annual plans cancelled within 14 days.',
        playbooks: [
          {
            ...DIRECT_PLAYBOOK,
            gotchas: ['Refunds are decided case by case and are not automatic.'],
            refundPolicy: 'Partial months are not refunded; access runs to the end of the period.',
          },
        ],
      }),
    );
  });
});
