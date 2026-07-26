/**
 * Error taxonomy.
 *
 * Every error thrown across a package boundary is one of these, carries a stable `code`
 * that UI and logs can switch on, and never contains a secret. Brief §0.3 forbids silently
 * swallowed errors, so the corollary is that errors have to be worth catching.
 */

export type LedgerErrorCode =
  | 'INVALID_ARGUMENT'
  | 'CURRENCY_MISMATCH'
  | 'UNSUPPORTED_CURRENCY'
  | 'MONEY_OVERFLOW'
  | 'INVALID_DATE'
  | 'INVALID_INTERVAL'
  | 'INVALID_STATE_TRANSITION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'ENCRYPTION_ERROR';

export interface LedgerErrorOptions {
  readonly cause?: unknown;
  /** Structured detail for logs. Must never contain tokens, keys, or PANs. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly meta: Readonly<Record<string, unknown>>;

  constructor(code: LedgerErrorCode, message: string, options: LedgerErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LedgerError';
    this.code = code;
    this.meta = options.meta ?? {};
  }
}

export class InvalidArgumentError extends LedgerError {
  constructor(message: string, options?: LedgerErrorOptions) {
    super('INVALID_ARGUMENT', message, options);
    this.name = 'InvalidArgumentError';
  }
}

export class CurrencyMismatchError extends LedgerError {
  constructor(left: string, right: string) {
    super('CURRENCY_MISMATCH', `Cannot combine ${left} and ${right} without an explicit FX rate.`, {
      meta: { left, right },
    });
    this.name = 'CurrencyMismatchError';
  }
}

export class UnsupportedCurrencyError extends LedgerError {
  constructor(code: string) {
    super('UNSUPPORTED_CURRENCY', `Unknown ISO-4217 currency code: ${code}`, { meta: { code } });
    this.name = 'UnsupportedCurrencyError';
  }
}

export class InvalidStateTransitionError extends LedgerError {
  constructor(entity: string, from: string, to: string) {
    super('INVALID_STATE_TRANSITION', `${entity} cannot move from ${from} to ${to}.`, {
      meta: { entity, from, to },
    });
    this.name = 'InvalidStateTransitionError';
  }
}

export function isLedgerError(value: unknown): value is LedgerError {
  return value instanceof LedgerError;
}

/**
 * Narrows an unknown thrown value to something loggable without leaking internals.
 * Use at the top of catch blocks; never `catch {}`.
 */
export function describeError(value: unknown): { message: string; code?: LedgerErrorCode } {
  if (isLedgerError(value)) return { message: value.message, code: value.code };
  if (value instanceof Error) return { message: value.message };
  return { message: String(value) };
}
