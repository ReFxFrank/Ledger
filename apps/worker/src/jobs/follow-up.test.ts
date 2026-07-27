import { describe, expect, it } from 'vitest';
import { FixedClock } from '@ledger/core';
import { defaultPreferences, scheduleCancellationUnconfirmed } from '@ledger/notify';

import { type FollowUpRow, NUDGE_INTERVAL_MS, planFollowUp } from './follow-up';

const LONDON = 'Europe/London';

const row: FollowUpRow = {
  requestId: 'req-1',
  userId: 'user-1',
  subscriptionId: 'sub-1',
  status: 'awaiting_confirmation',
  deadlineAt: new Date('2026-06-01T09:00:00Z'),
  lastNudgedAt: null,
  subscriptionName: 'Gymbox',
  amountMinor: 4500,
  currency: 'GBP',
  intervalUnit: 'month',
  intervalCount: 1,
};

describe('an unconfirmed request', () => {
  it('nags on schedule and not twice in one day', () => {
    const firstRun = new FixedClock('2026-06-04T10:00:00Z');
    const first = planFollowUp(row, firstRun);
    expect(first).toMatchObject({ kind: 'nudge', requestId: 'req-1' });
    if (first.kind !== 'nudge') return;

    // Six hours later the job runs again — a redeploy, a manual trigger, a backlog drain.
    const nudged: FollowUpRow = { ...row, lastNudgedAt: first.at };
    expect(planFollowUp(nudged, new FixedClock('2026-06-04T16:00:00Z'))).toMatchObject({
      kind: 'skip',
      reason: 'nudged_within_the_day',
    });

    // A minute short of the interval is still the same day's nudge.
    const almost = new Date(first.at.getTime() + NUDGE_INTERVAL_MS - 60_000);
    expect(planFollowUp(nudged, new FixedClock(almost))).toMatchObject({
      kind: 'skip',
      reason: 'nudged_within_the_day',
    });

    // A day later it is due again.
    const nextDay = new Date(first.at.getTime() + NUDGE_INTERVAL_MS);
    expect(planFollowUp(nudged, new FixedClock(nextDay)).kind).toBe('nudge');
  });

  it('produces the same dedupe key on every nudge, so the user is only told once', () => {
    const prefs = defaultPreferences('user-1', LONDON, 'GBP');

    const day1 = planFollowUp(row, new FixedClock('2026-06-04T10:00:00Z'));
    const day2 = planFollowUp(
      { ...row, lastNudgedAt: new Date('2026-06-04T10:00:00Z') },
      new FixedClock('2026-06-05T10:00:00Z'),
    );
    if (day1.kind !== 'nudge' || day2.kind !== 'nudge') throw new Error('expected two nudges');

    const [first] = scheduleCancellationUnconfirmed(
      day1.notification,
      prefs,
      new FixedClock('2026-06-04T10:00:00Z'),
    );
    const [second] = scheduleCancellationUnconfirmed(
      day2.notification,
      prefs,
      new FixedClock('2026-06-05T10:00:00Z'),
    );

    // Keyed on the deadline, not on the day the nudge ran. The second insert conflicts away —
    // which is why `lastNudgedAt` bounds the work and the unique index bounds the noise.
    expect(first?.dedupeKey).toBe(second?.dedupeKey);
  });

  it('does not nag before the deadline', () => {
    expect(planFollowUp(row, new FixedClock('2026-05-30T10:00:00Z'))).toMatchObject({
      kind: 'skip',
      reason: 'deadline_not_passed',
    });
  });

  it('does not nag when no deadline was ever established', () => {
    expect(
      planFollowUp({ ...row, deadlineAt: null }, new FixedClock('2026-06-04T10:00:00Z')),
    ).toMatchObject({ kind: 'skip', reason: 'no_deadline' });
  });

  it('leaves a request the user has already resolved alone', () => {
    expect(
      planFollowUp({ ...row, status: 'confirmed' }, new FixedClock('2026-06-04T10:00:00Z')),
    ).toMatchObject({ kind: 'skip', reason: 'not_awaiting_confirmation' });
  });

  it('records the state machine’s own words on the timeline', () => {
    const decision = planFollowUp(row, new FixedClock('2026-06-04T10:00:00Z'));
    expect(decision).toMatchObject({ describe: 'Still unconfirmed past the deadline' });
  });
});
