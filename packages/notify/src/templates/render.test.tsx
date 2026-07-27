/**
 * Template rendering.
 *
 * Every notification type is rendered end to end, which is the cheapest way to keep "adding a
 * type without a template" a failure rather than a blank email. Beyond that, two properties are
 * asserted over all ten:
 *
 *  - the copy makes no legal claim (docs/legal-notes.md), checked with the same pattern the
 *    provider dataset is validated against;
 *  - the email links straight to the screen it is about, and that link appears in both the HTML
 *    and the plain-text alternative.
 */

import { describe, expect, it } from 'vitest';
import { MONTHLY, money } from '@ledger/core';
import { renderNotification } from './index';
import type { NotificationRequest, RenderContext, SubscriptionRef } from '../types';

/** Mirrors `LEGAL_CLAIM_PATTERN` in @ledger/providers, restated so notify keeps no dependency on it. */
const LEGAL_CLAIM =
  /\b(you have the right|legally required|the law (says|requires)|guaranteed? (refund|cancellation)|we (will )?cancel)\b/i;

const ctx: RenderContext = {
  appUrl: 'https://ledger.example/',
  locale: 'en-GB',
  timeZone: 'Europe/London',
};

const subscription: SubscriptionRef = {
  subscriptionId: 'sub-1',
  name: 'Netflix',
  amount: money(1299, 'GBP'),
  interval: MONTHLY,
};

const base = {
  userId: 'user-1',
  dedupeKey: 'k',
  scheduledFor: new Date('2026-07-01T08:00:00Z'),
  deferredFrom: null,
  channels: ['email'] as const,
  priority: 'normal' as const,
  subscriptionId: 'sub-1',
};

const requests: NotificationRequest[] = [
  {
    ...base,
    type: 'trial_ending',
    payload: { subscription, trialEndsOn: '2026-08-10', leadTimeDays: 3 },
  },
  {
    ...base,
    type: 'renewal_upcoming',
    payload: { subscription, renewsOn: '2026-08-10', leadTimeDays: 2 },
  },
  {
    ...base,
    type: 'price_changed',
    payload: {
      subscription,
      previousAmount: money(999, 'GBP'),
      newAmount: money(1299, 'GBP'),
      previousAnnual: money(11_988, 'GBP'),
      newAnnual: money(15_588, 'GBP'),
      annualDelta: money(3600, 'GBP'),
      deltaBps: 3003,
      effectiveFrom: '2026-07-01',
    },
  },
  {
    ...base,
    type: 'cancel_by_deadline',
    payload: {
      subscription,
      cancellationRequestId: 'req-1',
      deadlineOn: '2026-08-03',
      leadTimeDays: 7,
    },
  },
  {
    ...base,
    type: 'cancellation_unconfirmed',
    payload: {
      subscription,
      cancellationRequestId: 'req-1',
      deadlineOn: '2026-08-03',
      daysSinceDeadline: 3,
    },
  },
  {
    ...base,
    type: 'charged_after_cancellation',
    priority: 'high',
    payload: {
      subscription,
      cancellationRequestId: 'req-1',
      transactionId: 'txn-9',
      merchantName: 'NETFLIX.COM',
      amount: money(1299, 'GBP'),
      chargedOn: '2026-07-10',
      cancelledOn: '2026-06-02',
      confirmationReference: 'NFX-11923',
      evidenceCount: 2,
    },
  },
  {
    ...base,
    type: 'new_detections',
    subscriptionId: null,
    payload: {
      weekOf: '2026-07-26',
      items: [
        { detectionId: 'det-1', name: 'Spotify', amount: money(1199, 'GBP'), interval: MONTHLY },
      ],
    },
  },
  {
    ...base,
    type: 'sync_failed',
    subscriptionId: null,
    payload: { connectionId: 'conn-1', institutionName: 'Monzo', failingSince: '2026-07-01' },
  },
  {
    ...base,
    type: 'consent_expiring',
    subscriptionId: null,
    payload: {
      connectionId: 'conn-1',
      institutionName: 'Monzo',
      expiresOn: '2026-09-01',
      leadTimeDays: 14,
    },
  },
  {
    ...base,
    type: 'duplicate_detected',
    payload: {
      subscriptions: [subscription, { ...subscription, subscriptionId: 'sub-2', name: 'Netflix UK' }],
    },
  },
];

describe('renderNotification', () => {
  it('covers every notification type', () => {
    expect(new Set(requests.map((r) => r.type)).size).toBe(requests.length);
  });

  for (const request of requests) {
    it(`renders ${request.type} with a subject, a body, and a link to the right screen`, async () => {
      const rendered = await renderNotification(request, ctx);

      expect(rendered.subject.length).toBeGreaterThan(0);
      expect(rendered.subject.length).toBeLessThan(120);
      expect(rendered.html).toContain(rendered.url);
      expect(rendered.text).toContain(rendered.url);
      expect(rendered.url.startsWith('https://ledger.example/')).toBe(true);
      // No trailing-slash doubling from the configured app URL.
      expect(rendered.url).not.toContain('//subscriptions');
    });

    it(`makes no legal claim in ${request.type}`, async () => {
      const rendered = await renderNotification(request, ctx);
      expect(LEGAL_CLAIM.exec(rendered.subject)).toBeNull();
      expect(LEGAL_CLAIM.exec(rendered.text)).toBeNull();
    });
  }

  it('leads the price-change email with the annualized difference', async () => {
    const request = requests.find((r) => r.type === 'price_changed');
    const rendered = await renderNotification(request!, ctx);

    expect(rendered.subject).toContain('£36.00 a year');
    expect(rendered.text).toContain('£36.00 a year');
    // The per-charge figures are shown too, so the reader can check the working.
    expect(rendered.text).toContain('£9.99');
    expect(rendered.text).toContain('£12.99');
  });

  it('states merchant, amount, both dates and the evidence in the charged-after email', async () => {
    const request = requests.find((r) => r.type === 'charged_after_cancellation');
    const rendered = await renderNotification(request!, ctx);

    expect(rendered.subject).toBe('NETFLIX.COM charged £12.99 after you cancelled');
    expect(rendered.text).toContain('10 July 2026'); // charged
    expect(rendered.text).toContain('2 June 2026'); // cancelled
    expect(rendered.text).toContain('NFX-11923'); // provider reference
    expect(rendered.text).toContain('2 files'); // stored evidence
    expect(rendered.url).toBe('https://ledger.example/cancellations/req-1');
  });

  it('renders money in a monospace, tabular face', async () => {
    const request = requests.find((r) => r.type === 'renewal_upcoming');
    const rendered = await renderNotification(request!, ctx);
    expect(rendered.html).toContain('tabular-nums');
    expect(rendered.html).toContain('Geist Mono');
  });
});
