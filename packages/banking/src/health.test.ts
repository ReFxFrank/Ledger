/**
 * Connection health.
 *
 * The requirement being tested is a timing one: a connection whose consent lapses in nine days
 * must say so *now*, while it is still working, on a row that has never failed. Everything else
 * here is precedence — which of several true things the user is told first.
 */

import { describe, expect, it } from 'vitest';
import { FixedClock, MILLIS_PER_DAY } from '@ledger/core';

import {
  type ConnectionHealthInput,
  CONSENT_WARNING_DAYS,
  connectionsNeedingConsentWarning,
  deriveConnectionHealth,
} from './health';

const NOW = '2026-07-20T09:00:00Z';

function clockAt(instant = NOW): FixedClock {
  return new FixedClock(instant);
}

function inDays(days: number): Date {
  return new Date(new Date(NOW).getTime() + days * MILLIS_PER_DAY);
}

function connection(overrides: Partial<ConnectionHealthInput> = {}): ConnectionHealthInput {
  return {
    id: 'conn-1',
    institutionName: 'Fixture Bank',
    status: 'active',
    consentExpiresAt: inDays(80),
    lastSyncedAt: inDays(-1),
    backfillCompletedAt: inDays(-40),
    error: null,
    ...overrides,
  };
}

describe('consent expiry', () => {
  it('is quiet while there is plenty of time', () => {
    const health = deriveConnectionHealth(connection(), clockAt());
    expect(health.status).toBe('active');
    expect(health.needsAttention).toBe(false);
    expect(health.consentDaysRemaining).toBe(80);
  });

  it('warns before it breaks, on a connection that has never failed', () => {
    const health = deriveConnectionHealth(
      connection({ consentExpiresAt: inDays(9), error: null, status: 'active' }),
      clockAt(),
    );

    expect(health.status).toBe('consent_expiring');
    expect(health.needsAttention).toBe(true);
    // Nothing has gone wrong yet — the point of raising it here is that nothing has to.
    expect(health.retryable).toBe(false);
    expect(health.summary).toContain('9 days');
  });

  it('starts warning exactly at the lead time the notification uses', () => {
    const atBoundary = deriveConnectionHealth(
      connection({ consentExpiresAt: inDays(CONSENT_WARNING_DAYS) }),
      clockAt(),
    );
    const justOutside = deriveConnectionHealth(
      connection({ consentExpiresAt: inDays(CONSENT_WARNING_DAYS + 1) }),
      clockAt(),
    );

    expect(atBoundary.status).toBe('consent_expiring');
    expect(justOutside.status).toBe('active');
  });

  it('reports expiry once the deadline has passed', () => {
    const health = deriveConnectionHealth(
      connection({ consentExpiresAt: inDays(-1) }),
      clockAt(),
    );
    expect(health.status).toBe('consent_expired');
    expect(health.consentDaysRemaining).toBeLessThan(0);
    expect(health.needsAttention).toBe(true);
  });

  it('says nothing about consent when the aggregator does not set a deadline', () => {
    const health = deriveConnectionHealth(connection({ consentExpiresAt: null }), clockAt());
    expect(health.status).toBe('active');
    expect(health.consentDaysRemaining).toBeNull();
  });

  it('collects the connections a warning job should act on', () => {
    const rows = [
      connection({ id: 'a', consentExpiresAt: inDays(3) }),
      connection({ id: 'b', consentExpiresAt: inDays(60) }),
      connection({ id: 'c', consentExpiresAt: inDays(-5) }),
    ];
    expect(connectionsNeedingConsentWarning(rows, clockAt()).map((row) => row.connectionId)).toEqual([
      'a',
      'c',
    ]);
  });
});

describe('reauth', () => {
  it('is derived from the adapter error code, not from a status somebody remembered to write', () => {
    const health = deriveConnectionHealth(
      connection({ status: 'active', error: { code: 'reauth_required', retryable: false } }),
      clockAt(),
    );
    expect(health.status).toBe('reauth_required');
    expect(health.needsAttention).toBe(true);
  });

  it('treats a vanished link as needing a fresh sign-in', () => {
    const health = deriveConnectionHealth(
      connection({ error: { code: 'item_not_found', retryable: false } }),
      clockAt(),
    );
    expect(health.status).toBe('reauth_required');
  });

  it('outranks an expiry warning, because it is broken now rather than soon', () => {
    const health = deriveConnectionHealth(
      connection({
        consentExpiresAt: inDays(5),
        error: { code: 'reauth_required', retryable: false },
      }),
      clockAt(),
    );
    expect(health.status).toBe('reauth_required');
  });

  it('is outranked by consent that has already lapsed', () => {
    const health = deriveConnectionHealth(
      connection({
        consentExpiresAt: inDays(-2),
        error: { code: 'reauth_required', retryable: false },
      }),
      clockAt(),
    );
    expect(health.status).toBe('consent_expired');
  });
});

describe('errors', () => {
  it('does not ask the user to act on a bank outage', () => {
    const health = deriveConnectionHealth(
      connection({ error: { code: 'temporarily_unavailable', retryable: true } }),
      clockAt(),
    );
    expect(health.status).toBe('error');
    expect(health.needsAttention).toBe(false);
    expect(health.retryable).toBe(true);
  });

  it('does ask when retrying will not help', () => {
    const health = deriveConnectionHealth(
      connection({ error: { code: 'upstream', retryable: false } }),
      clockAt(),
    );
    expect(health.needsAttention).toBe(true);
  });
});

describe('summaries', () => {
  it('say what is happening without claiming what anyone is required to do', () => {
    const cases = [
      connection(),
      connection({ consentExpiresAt: inDays(2) }),
      connection({ consentExpiresAt: inDays(-2) }),
      connection({ error: { code: 'reauth_required', retryable: false } }),
      connection({ error: { code: 'temporarily_unavailable', retryable: true } }),
      connection({ status: 'disconnected' }),
      connection({ backfillCompletedAt: null }),
      connection({ lastSyncedAt: inDays(-9) }),
      connection({ lastSyncedAt: null, backfillCompletedAt: inDays(-1) }),
    ];

    // Brief §9.8 / docs/legal-notes.md: no sentence in the product asserts a right or an
    // obligation. This is the cheapest possible enforcement and it belongs next to the copy.
    const forbidden = /\b(legally|law|required to|entitled|guarantee|your right)\b/i;
    for (const input of cases) {
      const health = deriveConnectionHealth(input, clockAt());
      expect(health.summary).not.toMatch(forbidden);
      expect(health.summary.length).toBeGreaterThan(10);
    }
  });

  it('mentions a stale feed once it is worth mentioning', () => {
    expect(deriveConnectionHealth(connection({ lastSyncedAt: inDays(-9) }), clockAt()).summary).toContain(
      '9 days',
    );
    expect(deriveConnectionHealth(connection({ backfillCompletedAt: null }), clockAt()).summary).toContain(
      'importing',
    );
  });
});
