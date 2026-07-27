/**
 * The verification tests.
 *
 * There is no Postgres and no Redis here, and there does not need to be: every decision this job
 * makes lives in `planVerification`, which takes rows and a `Clock`. That is the whole reason the
 * job was written in two halves — "a charge that arrives twelve days after a cancellation raises
 * the alarm, and one that never arrives confirms it" is the single most important behaviour in the
 * product, and it should be provable in a millisecond rather than in a staging environment.
 */

import { describe, expect, it } from 'vitest';
import { FixedClock, money } from '@ledger/core';
import { defaultPreferences, scheduleChargedAfterCancellation } from '@ledger/notify';

import {
  type CandidateCharge,
  type VerificationCase,
  type VerificationRequest,
  type VerificationSubscription,
  amountMatches,
  chargeWindowFor,
  planVerification,
} from './verify-cancellation';

const LONDON = 'Europe/London';

const subscription: VerificationSubscription = {
  id: 'sub-1',
  status: 'cancel_scheduled',
  displayName: 'Streamly',
  amountMinor: 1299,
  currency: 'GBP',
  intervalUnit: 'month',
  intervalCount: 1,
  merchantId: 'merchant-1',
  normalizedKeys: ['STREAMLY COM'],
};

/** Cancelled on the 1st, next charge due on the 15th, watched until the 27th. */
const request: VerificationRequest = {
  id: 'req-1',
  userId: 'user-1',
  subscriptionId: 'sub-1',
  status: 'confirmed',
  expectedNextChargeAt: new Date('2026-06-15T00:00:00Z'),
  verificationWindowEndsAt: new Date('2026-06-27T00:00:00Z'),
  confirmationReference: 'CNF-88213',
  cancelledAt: new Date('2026-06-01T10:00:00Z'),
  evidenceCount: 2,
};

function charge(overrides: Partial<CandidateCharge> = {}): CandidateCharge {
  return {
    id: 'txn-1',
    postedAt: new Date('2026-06-13T04:12:00Z'),
    amountMinor: 1299,
    currency: 'GBP',
    normalizedKey: 'STREAMLY COM',
    merchantId: 'merchant-1',
    subscriptionId: 'sub-1',
    rawDescriptor: 'STREAMLY.COM/BILL 8829',
    pending: false,
    ...overrides,
  };
}

function kase(charges: readonly CandidateCharge[] = []): VerificationCase {
  return { request, subscription, charges };
}

describe('the verification window', () => {
  it('starts three days before the expected charge and ends when watching stops', () => {
    const window = chargeWindowFor(request);
    expect(window?.from.toISOString()).toBe('2026-06-12T00:00:00.000Z');
    expect(window?.to.toISOString()).toBe('2026-06-27T00:00:00.000Z');
  });

  it('is absent when the request never recorded one', () => {
    expect(chargeWindowFor({ ...request, verificationWindowEndsAt: null })).toBeNull();
  });
});

describe('amount matching', () => {
  it('accepts a price rise inside the tolerance and rejects an unrelated purchase', () => {
    expect(amountMatches(1299, 1299)).toBe(true);
    expect(amountMatches(1299, 1449)).toBe(true); // ~11.5% rise
    expect(amountMatches(1299, 4999)).toBe(false); // a one-off purchase from the same merchant
  });

  it('gives small amounts an absolute floor rather than a percentage', () => {
    // 15% of 199 is 29 minor units, which would reject a 50p VAT change on a £1.99 subscription.
    expect(amountMatches(199, 249)).toBe(true);
  });
});

describe('a charge absent in the verification window', () => {
  it('confirms the cancellation once the window has closed', () => {
    const decision = planVerification(kase(), new FixedClock('2026-06-28T06:00:00Z'));

    expect(decision.kind).toBe('verified');
    if (decision.kind !== 'verified') return;

    expect(decision.request).toMatchObject({
      from: 'confirmed',
      to: 'verified',
      trigger: 'verification_passed',
    });
    expect(decision.subscription).toMatchObject({
      from: 'cancel_scheduled',
      to: 'canceled',
      trigger: 'cancellation_verified',
    });
    // The point of the whole job: this is a fact about the bank feed, not a claim by a provider.
    expect(decision.announcement.because).toBe('expected_charge_did_not_arrive');
    expect(decision.announcement.amount).toEqual(money(1299, 'GBP'));
  });

  it('concludes nothing while the charge could still post', () => {
    const decision = planVerification(kase(), new FixedClock('2026-06-20T06:00:00Z'));
    expect(decision).toMatchObject({ kind: 'wait', reason: 'window_still_open' });
  });

  it('waits until the expected charge date has actually passed', () => {
    const decision = planVerification(kase(), new FixedClock('2026-06-10T06:00:00Z'));
    expect(decision).toMatchObject({ kind: 'wait', reason: 'not_due_yet' });
  });

  it('will not verify a request the provider never confirmed', () => {
    // `awaiting_confirmation → verified` is not a transition the machine allows: no charge came,
    // but there is also no claim to verify. That request belongs to the follow-up job.
    const decision = planVerification(
      { ...kase(), request: { ...request, status: 'awaiting_confirmation' } },
      new FixedClock('2026-06-28T06:00:00Z'),
    );
    expect(decision).toMatchObject({ kind: 'wait', reason: 'status_cannot_be_verified' });
  });
});

describe('a charge present 12 days after a confirmed cancellation', () => {
  // Cancelled 2026-06-01, charged 2026-06-13.
  const clock = new FixedClock('2026-06-16T09:00:00Z');

  it('raises charged_after_cancellation with the evidence attached', () => {
    const decision = planVerification(kase([charge()]), clock);

    expect(decision.kind).toBe('charged');
    if (decision.kind !== 'charged') return;

    expect(decision.request).toMatchObject({
      from: 'confirmed',
      to: 'failed',
      trigger: 'verification_failed',
    });
    // The subscription demonstrably still bills, so it goes back to active rather than staying
    // in a cancelled state the bank feed contradicts.
    expect(decision.subscription).toMatchObject({
      from: 'cancel_scheduled',
      to: 'active',
      trigger: 'charge_after_cancellation',
    });
    expect(decision.charge.id).toBe('txn-1');

    // Everything the email has to answer without the user opening anything.
    expect(decision.notification).toMatchObject({
      merchantName: 'Streamly',
      transactionId: 'txn-1',
      confirmationReference: 'CNF-88213',
      evidenceCount: 2,
    });
    expect(decision.notification.amount).toEqual(money(1299, 'GBP'));
    expect(decision.notification.chargedAt.toISOString()).toBe('2026-06-13T04:12:00.000Z');
    expect(decision.notification.cancelledAt.toISOString()).toBe('2026-06-01T10:00:00.000Z');
  });

  it('produces a high-priority request that ignores quiet hours', () => {
    const decision = planVerification(kase([charge()]), clock);
    if (decision.kind !== 'charged') throw new Error('expected a charged decision');

    const [notification] = scheduleChargedAfterCancellation(
      decision.notification,
      defaultPreferences('user-1', LONDON, 'GBP'),
      clock,
    );

    expect(notification?.type).toBe('charged_after_cancellation');
    expect(notification?.priority).toBe('high');
    // Not deferred: the exemption is a property of the type, and a dispute window is short.
    expect(notification?.deferredFrom).toBeNull();
    expect(notification?.payload).toMatchObject({
      merchantName: 'Streamly',
      chargedOn: '2026-06-13',
      cancelledOn: '2026-06-01',
      evidenceCount: 2,
    });
  });

  it('does not wait for the window to close before raising it', () => {
    // 2026-06-16 is well inside the window. Absence needs the full window; presence does not.
    expect(planVerification(kase([charge()]), clock).kind).toBe('charged');
  });

  it('fires from an unconfirmed request too', () => {
    const decision = planVerification(
      { ...kase([charge()]), request: { ...request, status: 'awaiting_confirmation' } },
      clock,
    );
    expect(decision).toMatchObject({ kind: 'charged', request: { from: 'awaiting_confirmation' } });
  });
});

describe('charges that are not the charge', () => {
  it('ignores a refund from the same merchant', () => {
    const decision = planVerification(
      kase([charge({ amountMinor: -1299 })]),
      new FixedClock('2026-06-28T06:00:00Z'),
    );
    expect(decision.kind).toBe('verified');
  });

  it('ignores a charge outside the window', () => {
    const decision = planVerification(
      kase([charge({ postedAt: new Date('2026-06-11T00:00:00Z') })]),
      new FixedClock('2026-06-28T06:00:00Z'),
    );
    expect(decision.kind).toBe('verified');
  });

  it('ignores a same-amount charge from an unrelated merchant', () => {
    const decision = planVerification(
      kase([
        charge({
          normalizedKey: 'CORNER SHOP',
          merchantId: 'merchant-2',
          subscriptionId: null,
        }),
      ]),
      new FixedClock('2026-06-28T06:00:00Z'),
    );
    expect(decision.kind).toBe('verified');
  });

  it('refuses to compare across currencies rather than guessing at a rate', () => {
    const decision = planVerification(
      kase([charge({ currency: 'EUR' })]),
      new FixedClock('2026-06-28T06:00:00Z'),
    );
    expect(decision.kind).toBe('verified');
  });

  it('prefers the posted row when a pending duplicate is in the same window', () => {
    const decision = planVerification(
      kase([
        charge({ id: 'txn-pending', pending: true, postedAt: new Date('2026-06-12T09:00:00Z') }),
        charge({ id: 'txn-posted', pending: false, postedAt: new Date('2026-06-13T04:12:00Z') }),
      ]),
      new FixedClock('2026-06-16T09:00:00Z'),
    );
    expect(decision).toMatchObject({ kind: 'charged', charge: { id: 'txn-posted' } });
  });
});

describe('racing the user', () => {
  it('records the cancellation outcome but leaves a subscription the machine will not move', () => {
    // The user reactivated in the meantime. `active --cancellation_verified--> ?` is not a
    // declared transition, so the subscription is left alone rather than silently overwritten.
    const decision = planVerification(
      { ...kase(), subscription: { ...subscription, status: 'active' } },
      new FixedClock('2026-06-28T06:00:00Z'),
    );
    expect(decision).toMatchObject({ kind: 'verified', subscription: null });
  });
});
