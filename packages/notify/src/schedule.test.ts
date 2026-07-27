/**
 * Scheduling, on a frozen clock.
 *
 * Two properties are load-bearing and everything else here supports them:
 *
 *  - each type fires at exactly its lead time, at the user's local send minute;
 *  - the dedupe key is identical across two scheduler runs at different wall-clock times, because
 *    `notifications.dedupe_key` is UNIQUE and that constraint is the only thing standing between a
 *    restarted worker and a user being told the same thing twice.
 */

import { describe, expect, it } from 'vitest';
import { FixedClock, MONTHLY, money, parsePlainDate } from '@ledger/core';
import {
  defaultPreferences,
  scheduleCancelByDeadline,
  scheduleCancellationUnconfirmed,
  scheduleChargedAfterCancellation,
  scheduleConsentExpiring,
  schedulePriceChanged,
  scheduleRenewalUpcoming,
  scheduleSyncFailed,
  scheduleTrialEnding,
} from './schedule';
import type { SubscriptionRef } from './types';

const LONDON = 'Europe/London';

function prefs(overrides: Parameters<typeof defaultPreferences>[3] = {}) {
  return defaultPreferences('user-1', LONDON, 'GBP', overrides);
}

const netflix: SubscriptionRef = {
  subscriptionId: 'sub-1',
  name: 'Netflix',
  amount: money(1299, 'GBP'),
  interval: MONTHLY,
};

const iso = (date: Date): string => date.toISOString();

describe('lead times', () => {
  it('fires trial_ending exactly 3 days before, at 09:00 local', () => {
    const clock = new FixedClock('2026-07-01T00:00:00Z');
    const [request] = scheduleTrialEnding(
      { subscription: netflix, trialEndsAt: new Date('2026-08-10T12:00:00Z') },
      prefs(),
      clock,
    );

    expect(request).toBeDefined();
    // 2026-08-07 09:00 BST is 08:00Z. The lead is counted in the user's calendar days, and the
    // send minute is resolved in their zone, not in UTC.
    expect(iso(request!.scheduledFor)).toBe('2026-08-07T08:00:00.000Z');
    expect(request!.deferredFrom).toBeNull();
    expect(request!.dedupeKey).toBe('trial_ending:sub-1:2026-08-10');
  });

  it('fires renewal_upcoming 2 days before when the amount clears the threshold', () => {
    const clock = new FixedClock('2026-07-01T00:00:00Z');
    const expensive: SubscriptionRef = { ...netflix, amount: money(2500, 'GBP') };

    const [request] = scheduleRenewalUpcoming(
      { subscription: expensive, renewsAt: new Date('2026-08-10T12:00:00Z'), alertOptIn: null },
      prefs(),
      clock,
    );

    expect(iso(request!.scheduledFor)).toBe('2026-08-08T08:00:00.000Z');
  });

  it('leaves renewal_upcoming off below the threshold, and honours an explicit opt-in', () => {
    const clock = new FixedClock('2026-07-01T00:00:00Z');
    const input = { subscription: netflix, renewsAt: new Date('2026-08-10T12:00:00Z') };

    // £12.99 is under the £20 default threshold.
    expect(scheduleRenewalUpcoming({ ...input, alertOptIn: null }, prefs(), clock)).toHaveLength(0);
    expect(scheduleRenewalUpcoming({ ...input, alertOptIn: true }, prefs(), clock)).toHaveLength(1);
    // And an explicit opt-out beats a large amount.
    expect(
      scheduleRenewalUpcoming(
        { ...input, subscription: { ...netflix, amount: money(9900, 'GBP') }, alertOptIn: false },
        prefs(),
        clock,
      ),
    ).toHaveLength(0);
  });

  it('fires cancel_by_deadline at 7 days and again at 1 day', () => {
    const clock = new FixedClock('2026-07-01T00:00:00Z');
    const requests = scheduleCancelByDeadline(
      {
        subscription: netflix,
        cancellationRequestId: 'req-1',
        deadlineAt: new Date('2026-08-10T00:00:00Z'),
      },
      prefs(),
      clock,
    );

    expect(requests).toHaveLength(2);
    expect(requests.map((r) => iso(r.scheduledFor))).toEqual([
      '2026-08-03T08:00:00.000Z',
      '2026-08-09T08:00:00.000Z',
    ]);
    expect(requests.map((r) => r.dedupeKey)).toEqual([
      'cancel_by_deadline:sub-1:2026-08-10:d7',
      'cancel_by_deadline:sub-1:2026-08-10:d1',
    ]);
  });

  it('fires cancellation_unconfirmed 3 days after the deadline', () => {
    const clock = new FixedClock('2026-07-01T00:00:00Z');
    const [request] = scheduleCancellationUnconfirmed(
      {
        subscription: netflix,
        cancellationRequestId: 'req-1',
        deadlineAt: new Date('2026-08-10T00:00:00Z'),
      },
      prefs(),
      clock,
    );

    expect(iso(request!.scheduledFor)).toBe('2026-08-13T08:00:00.000Z');
    expect(request!.dedupeKey).toBe('cancellation_unconfirmed:req-1:2026-08-10');
  });

  it('fires consent_expiring 14 days before', () => {
    const clock = new FixedClock('2026-07-01T00:00:00Z');
    const [request] = scheduleConsentExpiring(
      {
        connectionId: 'conn-1',
        institutionName: 'Monzo',
        expiresAt: new Date('2026-09-01T00:00:00Z'),
      },
      prefs(),
      clock,
    );

    expect(iso(request!.scheduledFor)).toBe('2026-08-18T08:00:00.000Z');
    expect(request!.dedupeKey).toBe('consent_expiring:conn-1:2026-09-01');
  });

  it('sends charged_after_cancellation immediately, at high priority', () => {
    const clock = new FixedClock('2026-07-01T14:00:00Z');
    const [request] = scheduleChargedAfterCancellation(
      {
        subscription: netflix,
        cancellationRequestId: 'req-1',
        transactionId: 'txn-9',
        merchantName: 'NETFLIX.COM',
        amount: money(1299, 'GBP'),
        chargedAt: new Date('2026-07-01T09:12:00Z'),
        cancelledAt: new Date('2026-06-02T10:00:00Z'),
        confirmationReference: 'NFX-11923',
        evidenceCount: 2,
      },
      prefs(),
      clock,
    );

    expect(iso(request!.scheduledFor)).toBe('2026-07-01T14:00:00.000Z');
    expect(request!.priority).toBe('high');
    expect(request!.dedupeKey).toBe('charged_after_cancellation:txn-9:2026-07-01');
  });

  it('drops a lead-time notification whose moment has passed, but not one merely late', () => {
    const trialEndsAt = new Date('2026-08-10T12:00:00Z');

    // Discovered on the day the trial ends: the 3-day lead is long gone, but the fact is live, so
    // it goes out now rather than being silently dropped.
    const sameDay = new FixedClock('2026-08-10T10:00:00Z');
    const late = scheduleTrialEnding({ subscription: netflix, trialEndsAt }, prefs(), sameDay);
    expect(late).toHaveLength(1);
    expect(iso(late[0]!.scheduledFor)).toBe('2026-08-10T10:00:00.000Z');

    // A fortnight later there is nothing useful to say.
    const stale = new FixedClock('2026-08-24T10:00:00Z');
    expect(scheduleTrialEnding({ subscription: netflix, trialEndsAt }, prefs(), stale)).toHaveLength(0);
  });

  it('produces nothing at all when the user has switched a type off', () => {
    const clock = new FixedClock('2026-07-01T00:00:00Z');
    const off = prefs({ byType: { trial_ending: { channels: [], leadTimeDays: null } } });

    expect(
      scheduleTrialEnding(
        { subscription: netflix, trialEndsAt: new Date('2026-08-10T12:00:00Z') },
        off,
        clock,
      ),
    ).toHaveLength(0);
  });

  it('honours a custom lead time', () => {
    const clock = new FixedClock('2026-07-01T00:00:00Z');
    const custom = prefs({ byType: { trial_ending: { channels: ['email'], leadTimeDays: 7 } } });

    const [request] = scheduleTrialEnding(
      { subscription: netflix, trialEndsAt: new Date('2026-08-10T12:00:00Z') },
      custom,
      clock,
    );
    expect(iso(request!.scheduledFor)).toBe('2026-08-03T08:00:00.000Z');
    expect(request!.channels).toEqual(['email']);
  });
});

describe('dedupe keys', () => {
  const trialEndsAt = new Date('2026-08-10T12:00:00Z');

  it('is identical across two scheduler runs at different wall-clock times', () => {
    // Two runs days apart, one of them inside quiet hours so the *scheduled* instant differs.
    const first = scheduleTrialEnding(
      { subscription: netflix, trialEndsAt },
      prefs(),
      new FixedClock('2026-07-01T02:13:44Z'),
    );
    const second = scheduleTrialEnding(
      { subscription: netflix, trialEndsAt },
      prefs(),
      new FixedClock('2026-08-07T22:47:10Z'),
    );

    expect(first[0]!.dedupeKey).toBe(second[0]!.dedupeKey);
    expect(first[0]!.dedupeKey).toBe('trial_ending:sub-1:2026-08-10');
    // …and the runs genuinely disagreed about when to send, which is the point.
    expect(iso(first[0]!.scheduledFor)).not.toBe(iso(second[0]!.scheduledFor));
  });

  it('does not move when a different timezone changes the send instant', () => {
    const london = scheduleTrialEnding(
      { subscription: netflix, trialEndsAt },
      defaultPreferences('user-1', LONDON, 'GBP'),
      new FixedClock('2026-07-01T00:00:00Z'),
    );
    const tokyo = scheduleTrialEnding(
      { subscription: netflix, trialEndsAt },
      defaultPreferences('user-1', 'Asia/Tokyo', 'GBP'),
      new FixedClock('2026-07-01T00:00:00Z'),
    );

    // Tokyo's local trial-end date is the 10th too (21:00 local), so the key matches even though
    // the send instant is nine hours apart.
    expect(tokyo[0]!.dedupeKey).toBe(london[0]!.dedupeKey);
    expect(iso(tokyo[0]!.scheduledFor)).toBe('2026-08-07T00:00:00.000Z');
  });

  it('gives the two cancel-by calls distinct but individually stable keys', () => {
    const input = {
      subscription: netflix,
      cancellationRequestId: 'req-1',
      deadlineAt: new Date('2026-08-10T00:00:00Z'),
    };
    const runA = scheduleCancelByDeadline(input, prefs(), new FixedClock('2026-07-01T00:00:00Z'));
    const runB = scheduleCancelByDeadline(input, prefs(), new FixedClock('2026-07-14T19:22:00Z'));

    expect(runA.map((r) => r.dedupeKey)).toEqual(runB.map((r) => r.dedupeKey));
    expect(new Set(runA.map((r) => r.dedupeKey)).size).toBe(2);
  });

  it('keys sync_failed on the start of the failing run, not on the day we noticed', () => {
    const failingSince = new Date('2026-07-01T06:00:00Z');
    const day1 = scheduleSyncFailed(
      { connectionId: 'conn-1', institutionName: 'Monzo', failingSince },
      prefs(),
      new FixedClock('2026-07-01T07:00:00Z'),
    );
    const day5 = scheduleSyncFailed(
      { connectionId: 'conn-1', institutionName: 'Monzo', failingSince },
      prefs(),
      new FixedClock('2026-07-05T07:00:00Z'),
    );

    // Same key on both days: one broken connection is one email, not one a day.
    expect(day5[0]!.dedupeKey).toBe(day1[0]!.dedupeKey);
    expect(day1[0]!.dedupeKey).toBe('sync_failed:conn-1:2026-07-01');
  });
});

describe('price_changed', () => {
  it('produces exactly one alert for 9.99 → 12.99 monthly, stating £36.00 a year', () => {
    const clock = new FixedClock('2026-07-01T12:00:00Z');
    const subscription: SubscriptionRef = { ...netflix, amount: money(1299, 'GBP') };

    const requests = schedulePriceChanged(
      {
        subscription,
        previousAmount: money(999, 'GBP'),
        newAmount: money(1299, 'GBP'),
        effectiveFrom: parsePlainDate('2026-07-01'),
      },
      prefs(),
      clock,
    );

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.type).toBe('price_changed');
    if (request.type !== 'price_changed') throw new Error('unreachable');

    expect(request.payload.previousAnnual).toEqual(money(11_988, 'GBP'));
    expect(request.payload.newAnnual).toEqual(money(15_588, 'GBP'));
    // £36.00 a year — the number the email leads with.
    expect(request.payload.annualDelta).toEqual(money(3600, 'GBP'));
    expect(request.payload.deltaBps).toBe(3003);
  });

  it('collapses a re-reported change to the same single alert', () => {
    const input = {
      subscription: netflix,
      previousAmount: money(999, 'GBP'),
      newAmount: money(1299, 'GBP'),
      effectiveFrom: parsePlainDate('2026-07-01'),
    };
    const first = schedulePriceChanged(input, prefs(), new FixedClock('2026-07-01T12:00:00Z'));
    const second = schedulePriceChanged(input, prefs(), new FixedClock('2026-07-04T03:00:00Z'));

    expect(second[0]!.dedupeKey).toBe(first[0]!.dedupeKey);
    expect(first[0]!.dedupeKey).toBe('price_changed:sub-1:2026-07-01');
  });

  it('stays quiet for a sub-3% wobble', () => {
    const clock = new FixedClock('2026-07-01T12:00:00Z');
    expect(
      schedulePriceChanged(
        {
          subscription: netflix,
          previousAmount: money(999, 'GBP'),
          newAmount: money(1009, 'GBP'),
          effectiveFrom: parsePlainDate('2026-07-01'),
        },
        prefs(),
        clock,
      ),
    ).toHaveLength(0);
  });

  it('annualizes a 4-weekly change as thirteen charges, not twelve', () => {
    const clock = new FixedClock('2026-07-01T12:00:00Z');
    const fourWeekly: SubscriptionRef = {
      ...netflix,
      interval: { unit: 'week', count: 4 },
    };

    const requests = schedulePriceChanged(
      {
        subscription: fourWeekly,
        previousAmount: money(1000, 'GBP'),
        newAmount: money(1200, 'GBP'),
        effectiveFrom: parsePlainDate('2026-07-01'),
      },
      prefs(),
      clock,
    );

    const request = requests[0]!;
    if (request.type !== 'price_changed') throw new Error('unreachable');
    // 365/28 charges a year: £2.00 more per charge is £26.07 a year, not £24.00.
    expect(request.payload.annualDelta).toEqual(money(2607, 'GBP'));
  });
});
