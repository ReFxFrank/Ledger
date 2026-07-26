/**
 * Logging.
 *
 * `console.log` is a lint error everywhere except here. That is not fussiness: this app holds a
 * map of someone's financial life, and the failure mode of ad-hoc logging is an access token or
 * an account number sitting in a log aggregator forever.
 *
 * So there is one logger, it redacts by path, and the redaction list is a denylist of every
 * field name that has ever plausibly held a secret in this codebase.
 */

import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * Redaction paths. `*` matches one level, `**` matches any depth.
 *
 * Redaction is belt-and-braces — the real defence is that raw tokens never leave
 * `@ledger/crypto` — but a log line is exactly where a defence-in-depth layer earns its keep.
 */
const REDACT_PATHS = [
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
].flatMap((field) => [field, `*.${field}`, `*.*.${field}`, `req.headers.${field.toLowerCase()}`]);

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface CreateLoggerOptions {
  readonly name: string;
  readonly level?: LogLevel;
  /** Pretty-print for humans. Defaults to on outside production. */
  readonly pretty?: boolean;
  readonly base?: Record<string, unknown>;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const level = options.level ?? (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info';
  const pretty = options.pretty ?? process.env['NODE_ENV'] !== 'production';

  const config: LoggerOptions = {
    name: options.name,
    level,
    base: { service: options.name, ...options.base },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (pretty && level !== 'silent') {
    return pino({
      ...config,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
      },
    });
  }

  return pino(config);
}

/** The default application logger. Prefer a child logger with a `module` binding. */
export const logger: Logger = createLogger({ name: 'ledger' });

export function childLogger(module: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ module, ...bindings });
}

export type { Logger };
