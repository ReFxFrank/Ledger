/**
 * Authentication error copy.
 *
 * better-auth returns a stable `code` and a terse English `message`. The message is written for
 * a developer reading a log, and shipping it to a person who is locked out of their own account
 * is how "Invalid credentials" happens. Every line here says what went wrong *and* what to do
 * next, which is the whole test a sign-in error has to pass.
 *
 * Deliberately vague on one axis: a wrong email and a wrong password give the same sentence, so
 * the form cannot be used to enumerate which addresses have accounts.
 */

export interface AuthErrorLike {
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly status?: number | undefined;
}

const MESSAGES: Readonly<Record<string, string>> = {
  INVALID_EMAIL_OR_PASSWORD: 'That email and password do not match an account. Check both and try again.',
  INVALID_PASSWORD: 'That password is wrong. Try again, or use a backup code if you have lost access.',
  USER_NOT_FOUND: 'That email and password do not match an account. Check both and try again.',
  USER_EMAIL_NOT_FOUND: 'That email and password do not match an account. Check both and try again.',
  CREDENTIAL_ACCOUNT_NOT_FOUND: 'That email and password do not match an account. Check both and try again.',

  USER_ALREADY_EXISTS: 'An account already uses that email. Sign in instead, or use another address.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    'An account already uses that email. Sign in instead, or use another address.',
  INVALID_EMAIL: 'That does not look like an email address. Check it and try again.',

  PASSWORD_TOO_SHORT: 'Passwords need at least 12 characters. Add a few more.',
  PASSWORD_TOO_LONG: 'That password is longer than 256 characters. Shorten it and try again.',

  INVALID_CODE: 'That code did not match. Codes change every 30 seconds — wait for the next one and retype it.',
  INVALID_BACKUP_CODE: 'That backup code did not match. Each one works once; try the next unused code.',
  TOTP_NOT_ENABLED: 'This account has no authenticator app set up. Sign in and finish setting one up.',
  TWO_FACTOR_NOT_ENABLED: 'This account has no second factor set up. Sign in and finish setting one up.',
  BACKUP_CODES_NOT_ENABLED: 'This account has no backup codes. Use your authenticator app instead.',
  INVALID_TWO_FACTOR_COOKIE: 'This step timed out. Enter your email and password again to restart sign-in.',
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: 'Too many tries. Wait for a fresh code in your authenticator app, then enter it.',
  ACCOUNT_TEMPORARILY_LOCKED: 'Too many failed attempts locked this account for a few minutes. Try again shortly.',

  SESSION_EXPIRED: 'Your session ended. Sign in again to carry on.',
  SESSION_NOT_FRESH: 'Confirm your password again before making this change.',
  FAILED_TO_CREATE_USER: 'The account could not be created. Try again in a moment.',
  FAILED_TO_CREATE_SESSION: 'Signing you in failed after the password checked out. Try again in a moment.',
};

/** Rate limiting comes back as a bare 429 with no code, so status carries the meaning. */
const STATUS_MESSAGES: Readonly<Record<number, string>> = {
  429: 'Too many attempts from here. Wait a minute, then try again.',
  500: 'Something on our side failed. Try again in a moment — nothing was changed.',
  502: 'We could not reach the service. Check your connection and try again.',
  503: 'The service is briefly unavailable. Try again in a moment.',
};

export function authErrorMessage(error: AuthErrorLike | null | undefined, fallback: string): string {
  if (error === null || error === undefined) return fallback;

  const byCode = error.code === undefined ? undefined : MESSAGES[error.code];
  if (byCode !== undefined) return byCode;

  const byStatus = error.status === undefined ? undefined : STATUS_MESSAGES[error.status];
  if (byStatus !== undefined) return byStatus;

  return fallback;
}

/**
 * For a thrown value rather than a returned one — a dropped connection, an aborted WebAuthn
 * prompt. `fetch` rejecting is the common case and it is worth naming, because "check your
 * connection" is actionable and "TypeError: Failed to fetch" is not.
 */
export function thrownErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.name === 'NotAllowedError') {
    return 'That was cancelled or timed out. Try again when you are ready.';
  }
  if (error instanceof TypeError) {
    return 'We could not reach the server. Check your connection and try again.';
  }
  return fallback;
}
