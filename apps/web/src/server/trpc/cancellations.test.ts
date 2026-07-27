/**
 * The playbook resolution order — brief §3.1 step 1, the single most important behaviour in the
 * product.
 *
 * `resolvePlaybook` is a pure function from (channel, name, rows) to a checklist, which is why
 * this suite needs no Postgres and no session. The invariant these tests exist to hold: a
 * subscription billed through a store is NEVER shown the merchant's `direct` playbook, however
 * detailed that playbook is, because the provider's own cancel page cannot stop a store-billed
 * charge. `findPlaybook` in @ledger/providers refuses the same fallback; the resolver here must
 * keep the refusal.
 */

import { describe, expect, it } from 'vitest';
import { INTERMEDIATED_CHANNELS, type BillingChannel } from '@ledger/core';
import {
  type MerchantPlaybook,
  resolvePlaybook,
} from '~/server/trpc/routers/cancellations';

// ── fixtures ───────────────────────────────────────────────────────────────────────────

function playbookRow(patch: Partial<MerchantPlaybook> = {}): MerchantPlaybook {
  return {
    channel: 'direct',
    method: 'account_settings',
    difficulty: 1,
    cancelUrl: 'https://example.com/account/cancel',
    steps: [
      { text: 'Sign in and open Account.' },
      { text: 'Choose Cancel membership.', detail: 'Under the Membership card.' },
      { text: 'Confirm on the second screen.', warning: 'Closing the tab early leaves it running.' },
    ],
    phone: null,
    noticePeriodDays: 0,
    retentionOfferNotes: 'They will offer a cheaper plan instead of a discount.',
    gotchas: ['Access runs to the end of the paid period.'],
    letterTemplate: null,
    evidenceHint: 'Screenshot the page showing the end date.',
    sourceUrl: 'https://example.com/help/cancel',
    lastVerifiedAt: new Date('2026-07-25T00:00:00.000Z'),
    ...patch,
  };
}

const applePlaybook = playbookRow({
  channel: 'apple',
  method: 'app_store',
  cancelUrl: 'https://apps.apple.com/account/subscriptions',
  steps: [{ text: 'Open Settings, tap your name, tap Subscriptions.' }],
});

// ── a. the exact (merchant, channel) match ─────────────────────────────────────────────

describe('resolvePlaybook: merchant match', () => {
  it('uses the merchant playbook for the exact billing channel', () => {
    const resolved = resolvePlaybook('direct', 'Netflix', [playbookRow(), applePlaybook]);

    expect(resolved.source).toBe('merchant');
    expect(resolved.method).toBe('account_settings');
    expect(resolved.difficulty).toBe(1);
    expect(resolved.cancelUrl).toBe('https://example.com/account/cancel');
    expect(resolved.steps.map((step) => step.text)).toEqual([
      'Sign in and open Account.',
      'Choose Cancel membership.',
      'Confirm on the second screen.',
    ]);
  });

  it('prefers the channel playbook over the direct one when both exist', () => {
    const resolved = resolvePlaybook('apple', 'Netflix', [playbookRow(), applePlaybook]);

    expect(resolved.source).toBe('merchant');
    expect(resolved.method).toBe('app_store');
    expect(resolved.cancelUrl).toBe('https://apps.apple.com/account/subscriptions');
  });

  it('mints stable positional step ids, preserving detail and warning', () => {
    const resolved = resolvePlaybook('direct', 'Netflix', [playbookRow()]);

    expect(resolved.steps.map((step) => step.id)).toEqual(['step-1', 'step-2', 'step-3']);
    expect(resolved.steps[1]?.detail).toBe('Under the Membership card.');
    expect(resolved.steps[2]?.warning).toBe('Closing the tab early leaves it running.');
    // exactOptionalPropertyTypes: an absent detail is an absent key, not `undefined` written in.
    expect(resolved.steps[0]).not.toHaveProperty('detail');
  });

  it('carries the playbook notice period into the resolution', () => {
    const resolved = resolvePlaybook('direct', 'PureGym', [playbookRow({ noticePeriodDays: 30 })]);
    expect(resolved.noticePeriodDays).toBe(30);
  });

  it('falls back to the generic evidence hint when the row has none', () => {
    const resolved = resolvePlaybook('direct', 'Acme', [playbookRow({ evidenceHint: null })]);
    expect(resolved.evidenceHint).toBe(
      'Keep the confirmation email and a screenshot of the cancelled subscription.',
    );
  });
});

// ── b. the invariant: intermediated channels never see the direct playbook ─────────────

describe('resolvePlaybook: the store refusal', () => {
  it('gives an apple-billed subscription the store checklist, not the merchant direct playbook', () => {
    // The merchant knows only its own website. Its cancel page cannot stop an App Store charge,
    // so showing it here is the single most damaging thing this product could do.
    const resolved = resolvePlaybook('apple', 'Netflix', [playbookRow()]);

    expect(resolved.source).toBe('generic');
    expect(resolved.method).toBe('app_store');
    expect(resolved.cancelUrl).toBeNull();
    const text = resolved.steps.map((step) => step.text).join(' ');
    expect(text).toContain('Apple App Store');
    expect(text).not.toContain('Sign in and open Account.');
  });

  it('refuses the direct fallback on every intermediated channel', () => {
    for (const channel of INTERMEDIATED_CHANNELS) {
      const resolved = resolvePlaybook(channel, 'Acme', [playbookRow()]);

      expect(resolved.source).toBe('generic');
      expect(resolved.method).toBe(channel === 'carrier' ? 'account_settings' : 'app_store');
      // No step from the merchant's own flow leaks through.
      for (const step of resolved.steps) {
        expect(step.text).not.toContain('Cancel membership');
      }
    }
  });

  it('still uses a merchant playbook written for the store itself', () => {
    // The refusal is of the *direct* playbook, not of merchant knowledge: a real (merchant,
    // apple) entry is exactly what should be shown.
    const resolved = resolvePlaybook('apple', 'Netflix', [applePlaybook]);
    expect(resolved.source).toBe('merchant');
  });
});

// ── c. direct / paypal / unknown without merchant knowledge ────────────────────────────

describe('resolvePlaybook: the generic fallback', () => {
  it('gives an unknown merchant on a direct channel the generic checklist, unchanged', () => {
    const resolved = resolvePlaybook('direct', 'Mystery Gym');

    expect(resolved.source).toBe('generic');
    expect(resolved.method).toBe('account_settings');
    expect(resolved.difficulty).toBe(2);
    expect(resolved.noticePeriodDays).toBe(0);
    expect(resolved.steps.map((step) => step.id)).toEqual([
      'account',
      'find',
      'offers',
      'cancel',
      'confirm',
    ]);
  });

  it('keeps the paypal-specific generic steps for paypal with no merchant playbook', () => {
    const resolved = resolvePlaybook('paypal', 'Mystery Box');

    expect(resolved.source).toBe('generic');
    expect(resolved.steps.some((step) => step.text.includes('Automatic payments'))).toBe(true);
  });

  it('lets paypal and unknown channels borrow the merchant direct playbook', () => {
    // Same reasoning as findPlaybook: on a non-store channel the provider's own cancel flow is
    // still the right advice, so merchant knowledge beats the generic list.
    for (const channel of ['paypal', 'unknown'] as const satisfies readonly BillingChannel[]) {
      const resolved = resolvePlaybook(channel, 'Acme', [playbookRow()]);
      expect(resolved.source).toBe('merchant');
      expect(resolved.steps[0]?.text).toBe('Sign in and open Account.');
    }
  });

  it('rates the unknown channel harder than the known ones, honestly', () => {
    expect(resolvePlaybook('unknown', 'Mystery').difficulty).toBe(3);
  });
});
