/**
 * Connection health and consent expiry (brief §7).
 *
 * The requirement is one sentence long and it is the whole reason this file is separate from
 * `sync.ts`: **a connection problem is surfaced before it breaks, not after the first failed
 * sync.** Open-banking consent expires on a fixed clock — usually 90 days — and it does not
 * degrade. One day the sync works and the next it returns nothing, and the user finds out
 * because their subscriptions stopped updating, which is the worst possible way to find out.
 *
 * So health is *derived*, from the connection row and the clock, every time it is asked for. It
 * is not a status somebody remembered to write during a failure path. A row that has never
 * failed and never been touched still reports `consent_expiring` on day 76.
 *
 * Copy note: none of the messages here assert what a bank or a regulator requires. They describe
 * what will happen to this connection and what the user can do about it. See
 * `docs/legal-notes.md`.
 */

import { type Clock, type ConnectionStatus, MILLIS_PER_DAY } from '@ledger/core';

import { type AggregatorErrorCode, REAUTH_ERROR_CODES } from './adapter';

/**
 * How far ahead consent expiry is announced.
 *
 * Fourteen days, matching `DEFAULT_LEAD_TIME_DAYS.consent_expiring` in `@ledger/core` — the
 * notification and the badge have to agree, or the user gets an email about something the app
 * is not showing them.
 */
export const CONSENT_WARNING_DAYS = 14;

/**
 * When a connection is considered stale enough to mention.
 *
 * Not an error — a sync can legitimately be a few days old — but past this the absence of data
 * is itself information.
 */
export const STALE_SYNC_DAYS = 4;

export interface ConnectionHealthInput {
  readonly id: string;
  readonly institutionName: string;
  /** The stored status. Derivation can escalate it; it never quietly downgrades a real failure. */
  readonly status: ConnectionStatus;
  readonly consentExpiresAt: Date | null;
  readonly lastSyncedAt: Date | null;
  readonly backfillCompletedAt: Date | null;
  readonly error: { readonly code: string; readonly retryable: boolean } | null;
}

export interface ConnectionHealth {
  readonly connectionId: string;
  readonly status: ConnectionStatus;
  /** Whole days until consent lapses. Negative once it has. `null` when there is no deadline. */
  readonly consentDaysRemaining: number | null;
  /** True when the user has something to do. Drives the badge on /connections. */
  readonly needsAttention: boolean;
  /** True when only time will fix it — a bank outage. The UI says "we'll keep trying". */
  readonly retryable: boolean;
  /** Whole days since the last successful sync. `null` when it has never synced. */
  readonly staleDays: number | null;
  readonly backfillComplete: boolean;
  /** One sentence, user-facing. No legal claims — see the file header. */
  readonly summary: string;
}

/**
 * Derives the status a user should see.
 *
 * Precedence, most actionable first: disconnected → consent expired → reauth → consent expiring
 * → error → active. Reauth outranks "consent expiring" because a reauth is broken *now* and an
 * expiry is broken *soon*; telling someone their consent lapses in nine days while their bank is
 * already refusing to talk to us is technically true and practically useless.
 */
export function deriveConnectionHealth(
  input: ConnectionHealthInput,
  clock: Clock,
  warningDays: number = CONSENT_WARNING_DAYS,
): ConnectionHealth {
  const now = clock.epochMillis();
  const consentDaysRemaining =
    input.consentExpiresAt === null
      ? null
      : Math.floor((input.consentExpiresAt.getTime() - now) / MILLIS_PER_DAY);
  const staleDays =
    input.lastSyncedAt === null
      ? null
      : Math.floor((now - input.lastSyncedAt.getTime()) / MILLIS_PER_DAY);

  const base = {
    connectionId: input.id,
    consentDaysRemaining,
    staleDays,
    backfillComplete: input.backfillCompletedAt !== null,
  };

  if (input.status === 'disconnected') {
    return {
      ...base,
      status: 'disconnected',
      needsAttention: false,
      retryable: false,
      summary: `${input.institutionName} is no longer connected.`,
    };
  }

  if (consentDaysRemaining !== null && consentDaysRemaining < 0) {
    return {
      ...base,
      status: 'consent_expired',
      needsAttention: true,
      retryable: false,
      summary: `Your access to ${input.institutionName} has expired. Reconnect to keep tracking these subscriptions.`,
    };
  }

  if (isReauthCode(input.error?.code) || input.status === 'reauth_required') {
    return {
      ...base,
      status: 'reauth_required',
      needsAttention: true,
      retryable: false,
      summary: `${input.institutionName} needs you to sign in again before it can send new transactions.`,
    };
  }

  if (consentDaysRemaining !== null && consentDaysRemaining <= warningDays) {
    return {
      ...base,
      status: 'consent_expiring',
      needsAttention: true,
      // Not an error yet — nothing has failed, which is the entire point of raising it here.
      retryable: false,
      summary: `Your access to ${input.institutionName} ends in ${describeDays(consentDaysRemaining)}. Reconnect to avoid a gap.`,
    };
  }

  if (input.error !== null) {
    return {
      ...base,
      status: 'error',
      // A retryable failure is not the user's problem, so it does not get a badge asking them to
      // act on something they cannot act on.
      needsAttention: !input.error.retryable,
      retryable: input.error.retryable,
      summary: input.error.retryable
        ? `${input.institutionName} did not respond to the last sync. We will try again.`
        : `The last sync from ${input.institutionName} did not complete.`,
    };
  }

  return {
    ...base,
    status: 'active',
    needsAttention: false,
    retryable: false,
    summary: summariseActive(input.institutionName, staleDays, base.backfillComplete),
  };
}

/**
 * The connections that should produce a `consent_expiring` notification on this run.
 *
 * Separate from the badge because the notification fires once and the badge is continuous —
 * `notifications.dedupe_key` handles the once-ness, but only if it is asked at all.
 */
export function connectionsNeedingConsentWarning(
  inputs: readonly ConnectionHealthInput[],
  clock: Clock,
  warningDays: number = CONSENT_WARNING_DAYS,
): readonly ConnectionHealth[] {
  return inputs
    .map((input) => deriveConnectionHealth(input, clock, warningDays))
    .filter((health) => health.status === 'consent_expiring' || health.status === 'consent_expired');
}

function isReauthCode(code: string | undefined): boolean {
  if (code === undefined) return false;
  return REAUTH_ERROR_CODES.includes(code as AggregatorErrorCode);
}

function describeDays(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${String(days)} days`;
}

function summariseActive(
  institutionName: string,
  staleDays: number | null,
  backfillComplete: boolean,
): string {
  if (!backfillComplete) return `Still importing your history from ${institutionName}.`;
  if (staleDays === null) return `Connected to ${institutionName}. Waiting for the first sync.`;
  if (staleDays >= STALE_SYNC_DAYS) {
    return `No new transactions from ${institutionName} in ${describeDays(staleDays)}.`;
  }
  return `Connected to ${institutionName}.`;
}
