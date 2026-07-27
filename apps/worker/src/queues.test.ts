import { describe, expect, it } from 'vitest';
import { FixedClock } from '@ledger/core';

import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_JOB_OPTIONS,
  QUEUE_KEYS,
  REPEATABLE_JOBS,
  SYNC_JOB_BUCKET_MS,
  bucketedJobId,
  syncJobId,
} from './queues';

describe('idempotent job ids', () => {
  it('collapses repeat enqueues for one connection inside a bucket', () => {
    const clock = new FixedClock('2026-07-25T12:00:00Z');
    const first = syncJobId('conn-1', clock);

    // A webhook a few seconds later, then a user pressing refresh.
    clock.advanceMillis(4_000);
    expect(syncJobId('conn-1', clock)).toBe(first);
    clock.advanceMillis(SYNC_JOB_BUCKET_MS - 5_000);
    expect(syncJobId('conn-1', clock)).toBe(first);
  });

  it('opens a new bucket once the window has passed', () => {
    const clock = new FixedClock('2026-07-25T12:00:00Z');
    const first = syncJobId('conn-1', clock);
    clock.advanceMillis(SYNC_JOB_BUCKET_MS);
    expect(syncJobId('conn-1', clock)).not.toBe(first);
  });

  it('never collapses two different connections', () => {
    const clock = new FixedClock('2026-07-25T12:00:00Z');
    expect(syncJobId('conn-1', clock)).not.toBe(syncJobId('conn-2', clock));
  });

  it('is derived from the clock, not from wall time', () => {
    const a = bucketedJobId('sync', 'conn-1', new FixedClock('2026-01-01T00:00:00Z'), 60_000);
    const b = bucketedJobId('sync', 'conn-1', new FixedClock('2026-01-01T00:00:30Z'), 60_000);
    expect(a).toBe(b);
  });
});

describe('queue defaults', () => {
  it('bounds retention on both completed and failed jobs', () => {
    for (const key of QUEUE_KEYS) {
      const options = QUEUE_JOB_OPTIONS[key];
      expect(options.removeOnComplete).toBeDefined();
      expect(options.removeOnFail).toBeDefined();
    }
  });

  it('backs off exponentially rather than hammering a struggling aggregator', () => {
    expect(DEFAULT_JOB_OPTIONS.backoff).toMatchObject({ type: 'exponential' });
    expect(QUEUE_JOB_OPTIONS.sync.backoff).toMatchObject({ type: 'exponential' });
  });

  it('gives the sender fewer job attempts, because the row tracks its own', () => {
    // Stacking job retries on top of `notifications.attempts` multiplies the two.
    expect(QUEUE_JOB_OPTIONS.sender.attempts).toBeLessThan(QUEUE_JOB_OPTIONS.sync.attempts ?? 0);
  });
});

describe('the repeatable schedule', () => {
  it('gives every scheduler a stable, unique id', () => {
    const ids = REPEATABLE_JOBS.map((job) => job.schedulerId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not run two housekeeping jobs on the same minute of the hour', () => {
    const minutes = REPEATABLE_JOBS.flatMap((job) =>
      job.pattern === undefined ? [] : [job.pattern.split(' ')[0]],
    );
    expect(new Set(minutes).size).toBe(minutes.length);
  });

  it('covers every queue that is not driven by an event', () => {
    const scheduled = new Set<string>(REPEATABLE_JOBS.map((job) => job.queue));
    // `sync` is the only queue enqueued from outside — a webhook, a refresh, a continuation.
    expect([...QUEUE_KEYS].filter((key) => !scheduled.has(key))).toEqual(['sync']);
  });
});
