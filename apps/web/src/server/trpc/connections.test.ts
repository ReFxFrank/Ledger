/**
 * The decision logic behind "Connect a bank".
 *
 * Everything asserted here is a pure function from `~/server/banking/plan`, which is why this
 * suite needs no Postgres, no Redis, and no session. That is not a convenience — it is the reason
 * the rules below are functions at all. The alternative way to find out whether a two-run backfill
 * reports the user's subscription count once or twice is to connect a bank and read the toast, and
 * a rule you can only check by looking at a screen is a rule that quietly stops holding.
 */

import { describe, expect, it } from 'vitest';
import type { LinkSession, SyncResult } from '@ledger/banking';
import {
  MAX_INLINE_RUNS,
  accumulate,
  claimConnection,
  planLinkHandoff,
  shouldContinueInline,
} from '~/server/banking/plan';

// ── fixtures ───────────────────────────────────────────────────────────────────────────

function session(provider: string): LinkSession {
  return {
    provider,
    linkToken: `${provider}-link-abc123`,
    expiresAt: new Date('2026-07-27T12:00:00.000Z'),
  };
}

function result(patch: Partial<SyncResult> = {}): SyncResult {
  return {
    connectionId: '11111111-1111-4111-8111-111111111111',
    pages: 1,
    inserted: 0,
    updated: 0,
    settled: 0,
    removed: 0,
    skippedUnknownAccount: 0,
    cursor: 'fixture:v1:100',
    hasMore: false,
    backfillCompleted: false,
    detections: null,
    ...patch,
  };
}

function detections(patch: Partial<NonNullable<SyncResult['detections']>> = {}) {
  return {
    candidates: 0,
    inserted: 0,
    updated: 0,
    newKeys: 0,
    preservedKeys: 0,
    linkedTransactions: 0,
    ...patch,
  };
}

// ── the link handoff ───────────────────────────────────────────────────────────────────

describe('planLinkHandoff', () => {
  it('gives Plaid a handoff and withholds the public token', () => {
    const handoff = planLinkHandoff(session('plaid'));

    expect(handoff.mode).toBe('handoff');
    // The whole security story of the hosted flow is that the public token is minted by the
    // aggregator *after* the user signs in. A link token that doubled as one would mean the
    // server could open a connection without the user ever having authorised it.
    expect(handoff.publicToken).toBeNull();
  });

  it('completes the fixture immediately, and says so rather than faking a bank picker', () => {
    const handoff = planLinkHandoff(session('fixture'));

    expect(handoff.mode).toBe('immediate');
    expect(handoff.publicToken).toBe('fixture-link-abc123');
  });

  it('treats an unknown provider as immediate rather than stalling on a flow it cannot host', () => {
    expect(planLinkHandoff(session('truelayer')).mode).toBe('immediate');
  });

  it('passes the token and expiry through untouched', () => {
    const source = session('plaid');
    const handoff = planLinkHandoff(source);

    expect(handoff.provider).toBe('plaid');
    expect(handoff.linkToken).toBe(source.linkToken);
    expect(handoff.expiresAt).toEqual(source.expiresAt);
  });
});

// ── claiming the row ───────────────────────────────────────────────────────────────────

describe('claimConnection', () => {
  const mine = 'demo-user-ledger';

  it('reports a fresh insert as created', () => {
    expect(claimConnection({ id: 'conn-1' }, undefined, mine)).toEqual({
      kind: 'created',
      connectionId: 'conn-1',
    });
  });

  it('reuses the row when the same user reconnects the same bank', () => {
    // `bank_connections_item_unique` is global, so a deterministic item id — which is exactly what
    // the fixture produces per user — makes this the normal second-connect path, not an edge case.
    expect(claimConnection(undefined, { id: 'conn-1', userId: mine }, mine)).toEqual({
      kind: 'relinked',
      connectionId: 'conn-1',
    });
  });

  it('refuses a link that belongs to another user, and hands back no id', () => {
    const claim = claimConnection(undefined, { id: 'conn-1', userId: 'someone-else' }, mine);

    expect(claim.kind).toBe('taken');
    // A `connectionId` on this branch would be one careless destructure away from syncing
    // somebody else's bank into this user's account.
    expect(claim).not.toHaveProperty('connectionId');
  });

  it('refuses when the conflicting row cannot be read back at all', () => {
    // Insert conflicted, follow-up select found nothing: the row was deleted in between. Not ours
    // to claim, and not something to invent an id for.
    expect(claimConnection(undefined, undefined, mine).kind).toBe('taken');
  });
});

// ── the inline run budget ──────────────────────────────────────────────────────────────

describe('shouldContinueInline', () => {
  it('stops as soon as the aggregator says there is nothing more', () => {
    expect(shouldContinueInline(result({ hasMore: false }), 1)).toBe(false);
  });

  it('continues while there is more and budget left', () => {
    expect(shouldContinueInline(result({ hasMore: true }), 1)).toBe(true);
    expect(shouldContinueInline(result({ hasMore: true }), MAX_INLINE_RUNS - 1)).toBe(true);
  });

  it('stops at the budget even though the aggregator still has pages', () => {
    // The connection is left resumable, not broken: the cursor committed with each page, so the
    // next Sync starts where this one stopped.
    expect(shouldContinueInline(result({ hasMore: true }), MAX_INLINE_RUNS)).toBe(false);
    expect(shouldContinueInline(result({ hasMore: true }), MAX_INLINE_RUNS + 5)).toBe(false);
  });

  it('honours a caller-supplied budget', () => {
    expect(shouldContinueInline(result({ hasMore: true }), 2, 2)).toBe(false);
    expect(shouldContinueInline(result({ hasMore: true }), 1, 2)).toBe(true);
  });

  it('cannot loop forever on a zero budget', () => {
    expect(shouldContinueInline(result({ hasMore: true }), 0, 0)).toBe(false);
  });
});

// ── folding runs into one answer ───────────────────────────────────────────────────────

describe('accumulate', () => {
  it('sums the per-page counters across runs', () => {
    const totals = accumulate([
      result({ pages: 40, inserted: 4000, updated: 3, settled: 2, removed: 1, hasMore: true }),
      result({ pages: 7, inserted: 600, updated: 1, settled: 0, removed: 1, hasMore: false }),
    ]);

    expect(totals.pages).toBe(47);
    expect(totals.added).toBe(4600);
    expect(totals.updated).toBe(4);
    expect(totals.settled).toBe(2);
    expect(totals.removed).toBe(2);
  });

  it('sums newly-found detections but takes the candidate count from the last run only', () => {
    // This is the assertion the function exists for. `reconcileDetections` re-runs over the user's
    // whole history at the end of *every* run, so `candidates` is a snapshot of the same set —
    // summing it would tell a user with 18 subscriptions that we found 36. `newKeys` is a
    // difference against what was already stored, so it only counts once per key.
    const totals = accumulate([
      result({ hasMore: true, detections: detections({ candidates: 12, newKeys: 12 }) }),
      result({ hasMore: false, detections: detections({ candidates: 18, newKeys: 6 }) }),
    ]);

    expect(totals.detectionsFound).toBe(18);
    expect(totals.detectionsTotal).toBe(18);
  });

  it('reports hasMore from the last run, not from any earlier one', () => {
    const drained = accumulate([result({ hasMore: true }), result({ hasMore: false })]);
    expect(drained.hasMore).toBe(false);

    const budgetSpent = accumulate([result({ hasMore: true }), result({ hasMore: true })]);
    expect(budgetSpent.hasMore).toBe(true);
  });

  it('remembers a backfill that completed on an earlier run', () => {
    // `backfillCompleted` is true exactly once, on the run that drains the aggregator. A later
    // run reports false, and reading only the last one would lose the fact.
    const totals = accumulate([
      result({ backfillCompleted: true, hasMore: false }),
      result({ backfillCompleted: false, hasMore: false }),
    ]);

    expect(totals.backfillCompleted).toBe(true);
  });

  it('survives a run with no reconcile attached', () => {
    const totals = accumulate([result({ detections: null, inserted: 5 })]);

    expect(totals.added).toBe(5);
    expect(totals.detectionsFound).toBe(0);
    expect(totals.detectionsTotal).toBe(0);
  });

  it('returns zeroes rather than throwing on an empty run list', () => {
    const totals = accumulate([]);

    expect(totals).toEqual({
      pages: 0,
      added: 0,
      updated: 0,
      settled: 0,
      removed: 0,
      detectionsFound: 0,
      detectionsTotal: 0,
      backfillCompleted: false,
      hasMore: false,
    });
  });
});
