import { describe, expect, it } from 'vitest';
import { AggregatorError } from '@ledger/banking';
import { FixedClock } from '@ledger/core';

import {
  NOTIFY_AFTER_FAILING_MS,
  type StoredConnectionError,
  classifySyncFailure,
  resolveFailingSince,
} from './sync';

const clock = new FixedClock('2026-07-25T12:00:00Z');


describe('classifying a sync failure', () => {
  it('treats a revoked consent as terminal and worth telling the user about', () => {
    const decision = classifySyncFailure(
      new AggregatorError('plaid', 'consent_expired', 'Consent has lapsed.'),
      null,
      clock,
    );
    expect(decision).toMatchObject({ code: 'consent_expired', terminal: true, notifyUser: true });
  });

  it('treats a re-auth as terminal — ten exponential retries cannot log a user in', () => {
    const decision = classifySyncFailure(
      new AggregatorError('plaid', 'reauth_required', 'Sign in again.'),
      null,
      clock,
    );
    expect(decision.terminal).toBe(true);
    expect(decision.notifyUser).toBe(true);
  });

  it('does not email a user about our own misconfiguration', () => {
    const decision = classifySyncFailure(
      new AggregatorError('plaid', 'not_configured', 'PLAID_SECRET is missing.'),
      null,
      clock,
    );
    // Terminal, because retrying will not conjure a credential — but this is a deployment
    // problem, and the user cannot do anything with it.
    expect(decision).toMatchObject({ terminal: true, notifyUser: false });
  });

  it('retries a bank having a bad five minutes, quietly', () => {
    const decision = classifySyncFailure(
      new AggregatorError('plaid', 'temporarily_unavailable', 'Institution is down.'),
      null,
      clock,
    );
    expect(decision).toMatchObject({ terminal: false, notifyUser: false });
  });

  it('speaks up once a transient failure has stopped being transient', () => {
    const previous: StoredConnectionError = {
      code: 'temporarily_unavailable',
      message: 'Institution is down.',
      at: new Date(clock.epochMillis() - NOTIFY_AFTER_FAILING_MS - 1000).toISOString(),
      retryable: true,
    };
    const decision = classifySyncFailure(
      new AggregatorError('plaid', 'temporarily_unavailable', 'Institution is down.'),
      previous,
      clock,
    );
    expect(decision.notifyUser).toBe(true);
    expect(decision.failingSince.toISOString()).toBe(previous.at);
  });

  it('carries only the message off a non-aggregator error', () => {
    const decision = classifySyncFailure(new Error('socket hang up'), null, clock);
    expect(decision).toMatchObject({
      code: 'upstream',
      message: 'socket hang up',
      terminal: false,
    });
  });

  it('does not invent a message for a thrown non-error', () => {
    expect(classifySyncFailure('boom', null, clock).message).toBe(
      'Sync failed for an unknown reason.',
    );
  });
});

describe('dating the failing run', () => {
  it('carries the first failure forward so a week of outage is one email', () => {
    const previous: StoredConnectionError = {
      code: 'upstream',
      message: 'nope',
      at: '2026-07-18T04:00:00.000Z',
      retryable: true,
    };
    expect(resolveFailingSince(previous, clock.now()).toISOString()).toBe(
      '2026-07-18T04:00:00.000Z',
    );
  });

  it('starts a new run when the connection was healthy', () => {
    expect(resolveFailingSince(null, clock.now())).toEqual(clock.now());
  });

  it('falls back to now rather than producing an Invalid Date in a dedupe key', () => {
    const previous: StoredConnectionError = {
      code: 'upstream',
      message: 'nope',
      at: 'not a date',
      retryable: true,
    };
    expect(resolveFailingSince(previous, clock.now())).toEqual(clock.now());
  });
});

