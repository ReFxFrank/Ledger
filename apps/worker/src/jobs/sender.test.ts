import { describe, expect, it } from 'vitest';
import { FixedClock } from '@ledger/core';
import type { ChannelOutcome } from '@ledger/notify';

import { mapWithConcurrency, selectDue, summarizeOutcomes } from './sender';

const clock = new FixedClock('2026-07-25T12:00:00Z');

describe('folding channel outcomes', () => {
  it('treats one delivered channel as delivered and clears the error', () => {
    const outcomes: ChannelOutcome[] = [
      { channel: 'email', result: { status: 'failed', reason: 'timeout', retryable: true } },
      { channel: 'in_app', result: { status: 'sent' } },
    ];
    expect(summarizeOutcomes(outcomes)).toEqual({
      delivered: true,
      lastError: null,
      retryable: false,
    });
  });

  it('does not call a skipped channel a failure, or a delivery', () => {
    const outcomes: ChannelOutcome[] = [
      { channel: 'push', result: { status: 'skipped', reason: 'no push endpoints registered' } },
    ];
    const outcome = summarizeOutcomes(outcomes);
    expect(outcome.delivered).toBe(false);
    // Nothing transient went wrong, so another pass would produce the same result.
    expect(outcome.retryable).toBe(false);
    expect(outcome.lastError).toContain('no push endpoints registered');
  });

  it('reports a transient failure as retryable and a rejected address as not', () => {
    expect(
      summarizeOutcomes([
        { channel: 'email', result: { status: 'failed', reason: '503', retryable: true } },
      ]).retryable,
    ).toBe(true);

    expect(
      summarizeOutcomes([
        { channel: 'email', result: { status: 'failed', reason: 'invalid address', retryable: false } },
      ]).retryable,
    ).toBe(false);
  });

  it('says so when there was nowhere to deliver at all', () => {
    expect(summarizeOutcomes([]).lastError).toBe('no channels to deliver on');
  });
});

describe('choosing what to send', () => {
  const rows = [
    { id: 'a', scheduledFor: new Date('2026-07-25T11:00:00Z'), attempts: 0 },
    { id: 'b', scheduledFor: new Date('2026-07-25T10:00:00Z'), attempts: 0 },
    { id: 'c', scheduledFor: new Date('2026-07-25T13:00:00Z'), attempts: 0 },
    { id: 'd', scheduledFor: new Date('2026-07-24T10:00:00Z'), attempts: 5 },
  ];

  it('takes the due ones, oldest first', () => {
    expect(selectDue(rows, clock, 5, 10).map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('stops picking up a row that has run out of attempts', () => {
    // `d` is the oldest and would otherwise be first. This is what "does not retry forever" means.
    expect(selectDue(rows, clock, 5, 10).map((row) => row.id)).not.toContain('d');
    expect(selectDue(rows, clock, 6, 10).map((row) => row.id)).toContain('d');
  });

  it('honours the batch size', () => {
    expect(selectDue(rows, clock, 5, 1).map((row) => row.id)).toEqual(['b']);
  });
});

describe('bounded fan-out', () => {
  it('never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return value * 2;
    });

    expect(peak).toBeLessThanOrEqual(3);
    // Results stay in input order even though the work interleaves.
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
  });

  it('handles an empty batch without spawning anything', async () => {
    await expect(mapWithConcurrency([], 4, () => Promise.resolve(1))).resolves.toEqual([]);
  });
});
