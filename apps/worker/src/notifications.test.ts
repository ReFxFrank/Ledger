import { describe, expect, it } from 'vitest';
import { money } from '@ledger/core';

import { primaryChannel, priorityFor, toNotificationRequest } from './notifications';

describe('labelling the stored row', () => {
  it('prefers in_app, because that is the column the inbox reads', () => {
    // A notification the user asked to see in the app that is stored as `email` never appears
    // there — the inbox query filters on `channel = 'in_app'`.
    expect(primaryChannel(['email', 'push', 'in_app'])).toBe('in_app');
  });

  it('falls back to whatever channel there is', () => {
    expect(primaryChannel(['email'])).toBe('email');
    expect(primaryChannel(['push'])).toBe('push');
  });

  it('returns null when every channel is switched off', () => {
    expect(primaryChannel([])).toBeNull();
  });
});

describe('priority', () => {
  it('is high for exactly one type', () => {
    expect(priorityFor('charged_after_cancellation')).toBe('high');
    expect(priorityFor('renewal_upcoming')).toBe('normal');
    expect(priorityFor('trial_ending')).toBe('normal');
  });
});

describe('rebuilding a request from a stored row', () => {
  it('survives the JSONB round trip and re-derives the channels', () => {
    const payload = {
      subscription: {
        subscriptionId: 'sub-1',
        name: 'Streamly',
        amount: money(1299, 'GBP'),
        interval: { unit: 'month', count: 1 },
      },
      renewsOn: '2026-07-20',
      leadTimeDays: 2,
    };

    const request = toNotificationRequest(
      {
        id: 'n-1',
        userId: 'user-1',
        type: 'renewal_upcoming',
        channel: 'in_app',
        subscriptionId: 'sub-1',
        scheduledFor: new Date('2026-07-18T08:00:00Z'),
        deferredFrom: null,
        dedupeKey: 'renewal_upcoming:sub-1:2026-07-20',
        payload,
        attempts: 0,
      },
      // Read from the user's current preferences, not from the row: someone who turned push off
      // since the schedule should not be pushed.
      ['email', 'in_app'],
    );

    expect(request.type).toBe('renewal_upcoming');
    expect(request.channels).toEqual(['email', 'in_app']);
    expect(request.priority).toBe('normal');
    expect(request.payload).toEqual(payload);
  });
});
