import { describe, expect, it } from 'vitest';
import { FixedClock } from '@ledger/core';

import {
  type RetentionSnapshot,
  applyRetentionPlan,
  planRetention,
  retentionCutoff,
} from './retention';

const clock = new FixedClock('2026-07-25T12:00:00Z');

const snapshot: RetentionSnapshot = {
  transactions: [
    { id: 'txn-ancient', postedAt: new Date('2023-05-01T00:00:00Z') },
    { id: 'txn-old', postedAt: new Date('2024-01-10T00:00:00Z') },
    { id: 'txn-just-inside', postedAt: new Date('2024-07-26T00:00:00Z') },
    { id: 'txn-recent', postedAt: new Date('2026-07-01T00:00:00Z') },
  ],
  detections: [
    { id: 'det-1', evidenceTransactionIds: ['txn-old', 'txn-recent'] },
    { id: 'det-2', evidenceTransactionIds: [] },
  ],
  subscriptions: [{ id: 'sub-1' }, { id: 'sub-2' }],
  // The charge that landed after a cancellation. Evidence in a dispute.
  evidenceTransactionIds: ['txn-ancient'],
};

describe('the retention cutoff', () => {
  it('is calendar arithmetic, not 30-day months', () => {
    expect(retentionCutoff(24, clock).toISOString()).toBe('2024-07-25T00:00:00.000Z');
    expect(retentionCutoff(1, new FixedClock('2026-03-31T12:00:00Z')).toISOString()).toBe(
      // February has no 31st; the date clamps rather than rolling into March.
      '2026-02-28T00:00:00.000Z',
    );
  });
});

describe('the retention purge', () => {
  it('removes raw transactions and leaves subscriptions and detections', () => {
    const plan = planRetention(snapshot, 24, clock);
    const after = applyRetentionPlan(snapshot, plan);

    expect(plan.deleteTransactionIds).toEqual(['txn-old']);
    expect(after.transactions.map((row) => row.id)).toEqual([
      'txn-ancient',
      'txn-just-inside',
      'txn-recent',
    ]);

    // The whole point: the derived record survives the raw feed it was derived from.
    expect(after.detections).toEqual(snapshot.detections);
    expect(after.subscriptions).toEqual(snapshot.subscriptions);
    // Including the detection whose evidence now points at a purged transaction — a dangling
    // id is not a reason to discard a question the user already answered.
    expect(after.detections[0]?.evidenceTransactionIds).toContain('txn-old');
  });

  it('keeps a transaction cited as post-cancellation evidence, however old', () => {
    const plan = planRetention(snapshot, 24, clock);

    expect(plan.retainedAsEvidence).toEqual(['txn-ancient']);
    expect(plan.deleteTransactionIds).not.toContain('txn-ancient');
  });

  it('keeps everything on or after the cutoff', () => {
    const plan = planRetention(snapshot, 24, clock);
    expect(plan.deleteTransactionIds).not.toContain('txn-just-inside');
    expect(plan.deleteTransactionIds).not.toContain('txn-recent');
  });

  it('deletes nothing when the window is long enough to cover everything', () => {
    const plan = planRetention(snapshot, 120, clock);
    expect(plan.deleteTransactionIds).toEqual([]);
    expect(applyRetentionPlan(snapshot, plan)).toEqual(snapshot);
  });
});
