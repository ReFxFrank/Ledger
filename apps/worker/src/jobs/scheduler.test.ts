/**
 * The property this file exists to hold: two workers running the scheduler at the same instant,
 * or one worker running it twice after a restart, produce the same dedupe keys.
 *
 * That is what makes `insert … on conflict do nothing` a sufficient "never told twice" guarantee.
 * If a key ever depended on `now`, the constraint would silently stop protecting anything and the
 * only symptom would be a user getting two emails.
 */

import { describe, expect, it } from 'vitest';
import { FixedClock } from '@ledger/core';
import { defaultPreferences } from '@ledger/notify';

import {
  type SchedulerSubscription,
  type SchedulerUserInput,
  planUserNotifications,
  withinHorizon,
} from './scheduler';

const LONDON = 'Europe/London';
const prefs = defaultPreferences('user-1', LONDON, 'GBP');

function subscription(overrides: Partial<SchedulerSubscription> = {}): SchedulerSubscription {
  return {
    id: 'sub-1',
    displayName: 'Streamly',
    status: 'active',
    amountMinor: 1299,
    currency: 'GBP',
    intervalUnit: 'month',
    intervalCount: 1,
    trialEndsAt: null,
    nextRenewalAt: null,
    cancelByAt: null,
    cancellationRequestId: null,
    ...overrides,
  };
}

function input(overrides: Partial<SchedulerUserInput> = {}): SchedulerUserInput {
  return { prefs, subscriptions: [], connections: [], newDetections: [], ...overrides };
}

describe('the scheduler plan', () => {
  it('produces identical dedupe keys from two runs an hour apart', () => {
    const rows = input({
      subscriptions: [
        subscription({ nextRenewalAt: new Date('2026-07-20T00:00:00Z') }),
        subscription({
          id: 'sub-2',
          status: 'trialing',
          trialEndsAt: new Date('2026-07-18T00:00:00Z'),
        }),
        subscription({ id: 'sub-3', cancelByAt: new Date('2026-07-19T00:00:00Z') }),
      ],
      connections: [
        {
          id: 'conn-1',
          institutionName: 'Barclays',
          consentExpiresAt: new Date('2026-07-24T00:00:00Z'),
        },
      ],
    });

    const first = planUserNotifications(rows, new FixedClock('2026-07-10T08:00:00Z'));
    const second = planUserNotifications(rows, new FixedClock('2026-07-10T09:00:00Z'));

    expect(first.length).toBeGreaterThan(0);
    expect(first.map((request) => request.dedupeKey)).toEqual(
      second.map((request) => request.dedupeKey),
    );
  });

  it('gives the two cancel-by calls distinct keys', () => {
    const plan = planUserNotifications(
      input({ subscriptions: [subscription({ cancelByAt: new Date('2026-07-19T00:00:00Z') })] }),
      new FixedClock('2026-07-10T08:00:00Z'),
    );

    const keys = plan.filter((r) => r.type === 'cancel_by_deadline').map((r) => r.dedupeKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    // Fixed labels, not countdowns — `d7` reads the same on every run.
    expect(keys.some((key) => key.endsWith(':d7'))).toBe(true);
    expect(keys.some((key) => key.endsWith(':d1'))).toBe(true);
  });

  it('does not announce a renewal for a subscription that stopped charging', () => {
    const paused = planUserNotifications(
      input({
        subscriptions: [
          subscription({ status: 'paused', nextRenewalAt: new Date('2026-07-20T00:00:00Z') }),
        ],
      }),
      new FixedClock('2026-07-10T08:00:00Z'),
    );
    expect(paused.filter((r) => r.type === 'renewal_upcoming')).toEqual([]);
  });

  it('leaves distant events for a later run', () => {
    const clock = new FixedClock('2026-07-10T08:00:00Z');
    expect(withinHorizon(new Date('2026-08-01T00:00:00Z'), clock)).toBe(true);
    expect(withinHorizon(new Date('2027-01-01T00:00:00Z'), clock)).toBe(false);

    const plan = planUserNotifications(
      input({ subscriptions: [subscription({ nextRenewalAt: new Date('2027-01-01T00:00:00Z') })] }),
      clock,
    );
    expect(plan).toEqual([]);
  });

  it('says nothing when there is nothing to say', () => {
    expect(planUserNotifications(input(), new FixedClock('2026-07-10T08:00:00Z'))).toEqual([]);
  });
});
