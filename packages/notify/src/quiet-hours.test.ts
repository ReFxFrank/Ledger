/**
 * Quiet hours, on a frozen clock.
 *
 * The cases that matter are the ones a naive implementation gets wrong: a window that wraps
 * midnight, a deferral that crosses a DST boundary so the release minute sits at a different UTC
 * offset from the instant being deferred, and the one notification type that ignores the whole
 * mechanism.
 */

import { describe, expect, it } from 'vitest';
import { FixedClock, money } from '@ledger/core';
import { DEFAULT_QUIET_HOURS, applyQuietHours, isWithinQuietHours } from './quiet-hours';
import { defaultPreferences, scheduleChargedAfterCancellation, scheduleTrialEnding } from './schedule';
import type { SubscriptionRef } from './types';

const LONDON = 'Europe/London';
const window22to8 = { ...DEFAULT_QUIET_HOURS, timeZone: LONDON };
const iso = (date: Date): string => date.toISOString();

describe('isWithinQuietHours', () => {
  it('handles a window that wraps midnight', () => {
    expect(isWithinQuietHours(22 * 60, DEFAULT_QUIET_HOURS)).toBe(true);
    expect(isWithinQuietHours(23 * 60 + 59, DEFAULT_QUIET_HOURS)).toBe(true);
    expect(isWithinQuietHours(0, DEFAULT_QUIET_HOURS)).toBe(true);
    expect(isWithinQuietHours(7 * 60 + 59, DEFAULT_QUIET_HOURS)).toBe(true);
    // The end boundary is exclusive: 08:00 is when the user said they are awake.
    expect(isWithinQuietHours(8 * 60, DEFAULT_QUIET_HOURS)).toBe(false);
    expect(isWithinQuietHours(21 * 60 + 59, DEFAULT_QUIET_HOURS)).toBe(false);
  });

  it('handles a window inside one day', () => {
    const daytime = { enabled: true, startMinute: 60, endMinute: 6 * 60 };
    expect(isWithinQuietHours(2 * 60, daytime)).toBe(true);
    expect(isWithinQuietHours(7 * 60, daytime)).toBe(false);
    expect(isWithinQuietHours(0, daytime)).toBe(false);
  });

  it('treats an empty window as off rather than as all day', () => {
    const empty = { enabled: true, startMinute: 480, endMinute: 480 };
    expect(isWithinQuietHours(480, empty)).toBe(false);
    expect(isWithinQuietHours(0, empty)).toBe(false);
  });
});

describe('applyQuietHours', () => {
  const clock = new FixedClock('2026-07-01T00:00:00Z');

  it('leaves an instant outside the window alone', () => {
    const at = new Date('2026-07-10T12:00:00Z'); // 13:00 BST
    const decision = applyQuietHours(at, window22to8, clock);
    expect(decision.scheduledFor).toBe(at);
    expect(decision.deferredFrom).toBeNull();
  });

  it('defers an evening instant to the following morning', () => {
    // 22:30 BST on the 10th.
    const at = new Date('2026-07-10T21:30:00Z');
    const decision = applyQuietHours(at, window22to8, clock);
    // 08:00 BST on the 11th.
    expect(iso(decision.scheduledFor)).toBe('2026-07-11T07:00:00.000Z');
    expect(decision.deferredFrom).toBe(at);
  });

  it('defers an early-morning instant to the same morning, not the next one', () => {
    // 03:00 BST on the 10th — the tail of the previous night's window.
    const at = new Date('2026-07-10T02:00:00Z');
    const decision = applyQuietHours(at, window22to8, clock);
    expect(iso(decision.scheduledFor)).toBe('2026-07-10T07:00:00.000Z');
  });

  it('releases at the local minute across a spring-forward boundary', () => {
    // BST begins 2026-03-29 at 01:00 GMT. 02:30Z is 03:30 local, inside the window; the release is
    // 08:00 local, which is now 07:00Z rather than the 08:00Z it would have been the day before.
    const at = new Date('2026-03-29T02:30:00Z');
    const decision = applyQuietHours(at, window22to8, new FixedClock('2026-03-01T00:00:00Z'));
    expect(iso(decision.scheduledFor)).toBe('2026-03-29T07:00:00.000Z');
  });

  it('releases at the local minute across a fall-back boundary', () => {
    // BST ends 2026-10-25 at 02:00 BST → 01:00 GMT. 00:30Z is 01:30 BST, inside the window; the
    // release at 08:00 local is 08:00Z because the clocks went back in between.
    const at = new Date('2026-10-25T00:30:00Z');
    const decision = applyQuietHours(at, window22to8, new FixedClock('2026-10-01T00:00:00Z'));
    expect(iso(decision.scheduledFor)).toBe('2026-10-25T08:00:00.000Z');
  });

  it('never hands back an instant that has already passed', () => {
    // The release boundary is behind the clock; delivering "at 08:00 yesterday" would just mean
    // the sender fires immediately anyway, so say so honestly.
    const at = new Date('2026-07-10T02:00:00Z');
    const late = new FixedClock('2026-07-12T09:00:00Z');
    const decision = applyQuietHours(at, window22to8, late);
    expect(iso(decision.scheduledFor)).toBe('2026-07-12T09:00:00.000Z');
    expect(decision.deferredFrom).toBe(at);
  });

  it('does nothing when quiet hours are switched off', () => {
    const at = new Date('2026-07-10T02:00:00Z');
    const decision = applyQuietHours(at, { ...window22to8, enabled: false }, clock);
    expect(decision.scheduledFor).toBe(at);
    expect(decision.deferredFrom).toBeNull();
  });

  it('respects the timezone rather than the offset it had when it was set', () => {
    // 23:30 in Tokyo is 14:30Z; the same instant is 15:30 in London and perfectly awake.
    const at = new Date('2026-07-10T14:30:00Z');
    expect(applyQuietHours(at, { ...window22to8, timeZone: 'Asia/Tokyo' }, clock).deferredFrom).toBe(at);
    expect(applyQuietHours(at, window22to8, clock).deferredFrom).toBeNull();
  });
});

describe('quiet hours through the scheduler', () => {
  const netflix: SubscriptionRef = {
    subscriptionId: 'sub-1',
    name: 'Netflix',
    amount: money(1299, 'GBP'),
    interval: { unit: 'month', count: 1 },
  };

  it('defers a lead-time notification whose send minute lands in the window', () => {
    // Send minute set to 23:00, which is inside 22:00–08:00.
    const prefs = defaultPreferences('user-1', LONDON, 'GBP', { sendMinute: 23 * 60 });
    const [request] = scheduleTrialEnding(
      { subscription: netflix, trialEndsAt: new Date('2026-08-10T12:00:00Z') },
      prefs,
      new FixedClock('2026-07-01T00:00:00Z'),
    );

    expect(iso(request!.deferredFrom!)).toBe('2026-08-07T22:00:00.000Z'); // 23:00 BST
    expect(iso(request!.scheduledFor)).toBe('2026-08-08T07:00:00.000Z'); // 08:00 BST next day
    // The deferral did not touch the key.
    expect(request!.dedupeKey).toBe('trial_ending:sub-1:2026-08-10');
  });

  it('sends charged_after_cancellation straight through the quiet window', () => {
    // 01:30 BST — squarely inside 22:00–08:00.
    const clock = new FixedClock('2026-07-11T00:30:00Z');
    const [request] = scheduleChargedAfterCancellation(
      {
        subscription: netflix,
        cancellationRequestId: 'req-1',
        transactionId: 'txn-9',
        merchantName: 'NETFLIX.COM',
        amount: money(1299, 'GBP'),
        chargedAt: new Date('2026-07-11T00:10:00Z'),
        cancelledAt: new Date('2026-06-02T10:00:00Z'),
        confirmationReference: null,
        evidenceCount: 0,
      },
      defaultPreferences('user-1', LONDON, 'GBP'),
      clock,
    );

    expect(iso(request!.scheduledFor)).toBe('2026-07-11T00:30:00.000Z');
    expect(request!.deferredFrom).toBeNull();
    expect(request!.priority).toBe('high');
  });

  it('still defers everything else scheduled at the same instant', () => {
    const clock = new FixedClock('2026-07-11T00:30:00Z');
    const prefs = defaultPreferences('user-1', LONDON, 'GBP');
    const [request] = scheduleTrialEnding(
      { subscription: netflix, trialEndsAt: new Date('2026-07-11T12:00:00Z') },
      prefs,
      clock,
    );

    // Late discovery clamps the send to "now", which is inside the window — so it waits for 08:00.
    expect(iso(request!.scheduledFor)).toBe('2026-07-11T07:00:00.000Z');
    expect(iso(request!.deferredFrom!)).toBe('2026-07-11T00:30:00.000Z');
  });
});
