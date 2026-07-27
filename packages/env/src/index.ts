/**
 * Environment.
 *
 * Parsed once, at boot, and the process refuses to start if it is wrong. The alternative —
 * discovering that `ENCRYPTION_KEY` is empty when the first bank connection tries to seal a
 * token — costs a user their connection and produces a support ticket instead of a startup log.
 *
 * The server schema is never imported from a client component. `clientEnv` is the only thing
 * that crosses that boundary, and CI greps the built bundle to prove it (scripts/check-client-bundle.mjs).
 */

import { z } from 'zod';

const booleanish = z
  .enum(['true', 'false', '1', '0', ''])
  .transform((value) => value === 'true' || value === '1');

const nonEmpty = z.string().min(1);

/**
 * A URL restricted to specific schemes.
 *
 * `z.string().url()` alone is weaker than it looks: it delegates to the `URL` constructor, which
 * happily parses `localhost:5432` as a URL whose protocol is `localhost:`. So a `DATABASE_URL`
 * with the scheme left off passes validation and then fails at connection time with a driver
 * error that names none of this. Checking the scheme is what makes the boot-time check mean
 * something.
 */
const urlWithScheme = (schemes: readonly string[], example: string) =>
  z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          return schemes.includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { message: `must start with ${schemes.join(' or ')} — for example ${example}` },
    );

/** 32 bytes, base64. Checked here rather than at first use. */
const base64Key32 = z
  .string()
  .min(1, 'required')
  .refine((value) => Buffer.from(value, 'base64').length === 32, {
    message: 'must decode to exactly 32 bytes — generate with `openssl rand -base64 32`',
  });

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  APP_URL: urlWithScheme(['http:', 'https:'], 'https://ledger.example.com'),

  DATABASE_URL: urlWithScheme(
    ['postgresql:', 'postgres:'],
    'postgresql://ledger:password@localhost:5433/ledger',
  ),
  REDIS_URL: urlWithScheme(['redis:', 'rediss:'], 'redis://localhost:6380'),

  BETTER_AUTH_SECRET: nonEmpty.min(32, 'needs at least 32 characters of entropy'),
  BETTER_AUTH_URL: z.string().url().optional(),

  ENCRYPTION_KEY: base64Key32,
  ENCRYPTION_KEY_RETIRED: z.string().optional(),
  KMS_KEY_ARN: z.string().optional(),

  AGGREGATOR: z.enum(['plaid', 'fixture']).default('fixture'),
  PLAID_CLIENT_ID: z.string().optional(),
  PLAID_SECRET: z.string().optional(),
  PLAID_ENV: z.enum(['sandbox', 'development', 'production']).default('sandbox'),
  PLAID_WEBHOOK_SECRET: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Ledger <ledger@example.com>'),

  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),

  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('ledger-evidence'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanish.default('true'),

  SENTRY_DSN: z.string().optional(),

  TRANSACTION_RETENTION_MONTHS: z.coerce.number().int().min(1).max(120).default(24),

  FEATURE_PUBLIC_GUIDES: booleanish.default('false'),
  FEATURE_EMAIL_RECEIPTS: booleanish.default('false'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

/**
 * Cross-field rules the shape alone cannot express.
 *
 * `AGGREGATOR=plaid` without credentials is the specific mistake worth catching: everything
 * boots, the UI offers "Connect a bank", and the failure surfaces as an opaque 400 from Plaid
 * halfway through the Link flow.
 */
function crossValidate(env: ServerEnv): string[] {
  const problems: string[] = [];

  if (env.AGGREGATOR === 'plaid') {
    if (!env.PLAID_CLIENT_ID) problems.push('AGGREGATOR=plaid requires PLAID_CLIENT_ID');
    if (!env.PLAID_SECRET) problems.push('AGGREGATOR=plaid requires PLAID_SECRET');
  }

  if (env.NODE_ENV === 'production') {
    if (!env.RESEND_API_KEY) {
      problems.push('RESEND_API_KEY is required in production — notifications would silently not send');
    }
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
      problems.push('VAPID keys are required in production for web push');
    }
    if (env.APP_URL.startsWith('http://')) {
      problems.push('APP_URL must be https in production — session cookies are Secure-only');
    }
  }

  const hasPublic = Boolean(env.VAPID_PUBLIC_KEY);
  const hasPrivate = Boolean(env.VAPID_PRIVATE_KEY);
  if (hasPublic !== hasPrivate) {
    problems.push('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together');
  }

  return problems;
}

let cachedServerEnv: ServerEnv | null = null;

export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  if (cachedServerEnv !== null) return cachedServerEnv;

  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(
      `Environment is not usable. Fix these and restart:\n${lines.join('\n')}\n\n` +
        'See .env.example — every variable is documented there.',
    );
  }

  const problems = crossValidate(parsed.data);
  if (problems.length > 0) {
    throw new Error(`Environment is inconsistent:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }

  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

export function resetEnvCache(): void {
  cachedServerEnv = null;
}

export function loadClientEnv(source: Record<string, string | undefined>): ClientEnv {
  const parsed = clientEnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Public environment is not usable:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

/** True when the aggregator is the offline fixture — used to gate demo-only affordances. */
export function isFixtureAggregator(env: ServerEnv): boolean {
  return env.AGGREGATOR === 'fixture';
}
