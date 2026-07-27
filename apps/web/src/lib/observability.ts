import 'server-only';

import { childLogger } from '@ledger/logger';

/**
 * Error reporting, env-gated (brief §2, §10).
 *
 * A seam rather than a Sentry integration, deliberately: `@sentry/nextjs` is not in the
 * lockfile, and adding a dependency that phones a third party on every unhandled error is a
 * decision for whoever runs this deployment — not one to make on their behalf inside a
 * hardening pass. Until then this logs through the same pino instance as everything else, which
 * on a self-hosted box is where an operator is already looking.
 *
 * WHAT ADDING SENTRY LATER REQUIRES, concretely:
 *   1. `pnpm --filter @ledger/web add @sentry/nextjs`
 *   2. `instrumentation.ts` at the app root calling `Sentry.init({ dsn, tracesSampleRate })`,
 *      guarded on SENTRY_DSN so an unset DSN stays a no-op rather than a boot error.
 *   3. Replace the two function bodies below with `Sentry.captureException` /
 *      `Sentry.captureMessage`. Every call site already routes through here, so nothing else
 *      changes.
 *   4. Set `beforeSend` to the same redaction list as `scrub()` below. Sentry's own default
 *      scrubbing does not know about `access_token_ciphertext`.
 * `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` are already declared in .env.example and read by
 * the env schema, so step 2 has its configuration waiting for it.
 */

const log = childLogger('observability');

/**
 * Field names never allowed into a report.
 *
 * Mirrors the redaction list in `@ledger/logger`. Kept as its own copy rather than imported
 * because the logger's list is a pino `redact` path spec — a different shape for the same set —
 * and a report payload is a plain object walked here.
 */
const SENSITIVE = new Set([
  'accessToken',
  'access_token',
  'accessTokenCiphertext',
  'access_token_ciphertext',
  'refreshToken',
  'refresh_token',
  'publicToken',
  'public_token',
  'linkToken',
  'link_token',
  'password',
  'passwordHash',
  'secret',
  'clientSecret',
  'client_secret',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'sessionToken',
  'session_token',
  'totpSecret',
  'totp_secret',
  'twoFactorSecret',
  'encryptionKey',
  'dek',
  'kek',
  'privateKey',
  'cardNumber',
  'pan',
  'cvv',
  'iban',
  'accountNumber',
  'account_number',
  'routingNumber',
  'sortCode',
  'keyId',
  'key_id',
]);

export interface ReportContext {
  /** Which procedure, job, or boundary. */
  readonly where: string;
  /** Whose request — an id only. Never an email, which is itself identifying. */
  readonly userId?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Removes anything on the denylist, at any depth.
 *
 * Depth-bounded because an error's `cause` chain can be cyclic, and a reporter that hangs while
 * serialising is a worse outage than the error it was reporting.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE.has(key) ? '[redacted]' : scrub(item, depth + 1);
  }
  return out;
}

function describe(error: unknown): { message: string; name: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { message: String(error), name: 'NonError' };
}

/** True when a reporting backend is configured. Call sites do not need to care. */
export function isReportingEnabled(): boolean {
  const dsn = process.env['SENTRY_DSN'];
  return dsn !== undefined && dsn.trim() !== '';
}

/**
 * Reports an unexpected failure.
 *
 * Never throws: a reporter that can fail turns one error into two, and the second one has no
 * handler. Every path here is wrapped.
 */
export function captureException(error: unknown, context: ReportContext): void {
  try {
    const payload = {
      ...describe(error),
      where: context.where,
      ...(context.userId === undefined ? {} : { userId: context.userId }),
      ...(context.meta === undefined ? {} : { meta: scrub(context.meta) }),
      reported: isReportingEnabled(),
    };
    log.error(payload, 'unhandled failure');
  } catch {
    // Reporting is best-effort by definition. Swallowing here is the one place it is correct:
    // the alternative is an exception thrown from inside an error handler.
  }
}

export function captureMessage(message: string, context: ReportContext): void {
  try {
    log.warn(
      {
        where: context.where,
        ...(context.userId === undefined ? {} : { userId: context.userId }),
        ...(context.meta === undefined ? {} : { meta: scrub(context.meta) }),
      },
      message,
    );
  } catch {
    // As above.
  }
}
