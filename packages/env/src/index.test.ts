import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { isFixtureAggregator, loadClientEnv, loadServerEnv, resetEnvCache } from './index';

const KEY_32 = randomBytes(32).toString('base64');
const SECRET = 'x'.repeat(48);

/** The smallest environment that is allowed to boot. Everything else is layered on top. */
function minimal(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    APP_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://ledger:pw@localhost:5433/ledger',
    REDIS_URL: 'redis://localhost:6380',
    BETTER_AUTH_SECRET: SECRET,
    ENCRYPTION_KEY: KEY_32,
    ...overrides,
  };
}

beforeEach(() => {
  resetEnvCache();
});

describe('loadServerEnv — shape', () => {
  it('accepts a minimal development environment', () => {
    const env = loadServerEnv(minimal());
    expect(env.NODE_ENV).toBe('development');
    expect(env.AGGREGATOR).toBe('fixture');
    expect(env.TRANSACTION_RETENTION_MONTHS).toBe(24);
  });

  /**
   * The failure mode this prevents: discovering a missing variable when the first bank
   * connection tries to seal a token, rather than at startup. So the message has to name
   * everything wrong at once — fixing them one restart at a time is its own kind of bad.
   */
  it('reports every missing variable in one message, not just the first', () => {
    try {
      loadServerEnv({});
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      for (const name of [
        'APP_URL',
        'DATABASE_URL',
        'REDIS_URL',
        'BETTER_AUTH_SECRET',
        'ENCRYPTION_KEY',
      ]) {
        expect(message).toContain(name);
      }
      expect(message).toContain('.env.example');
    }
  });

  it('rejects an encryption key that is not 32 bytes, and says how to make one', () => {
    expect(() => loadServerEnv(minimal({ ENCRYPTION_KEY: randomBytes(16).toString('base64') }))).toThrow(
      /32 bytes/,
    );
    expect(() => loadServerEnv(minimal({ ENCRYPTION_KEY: randomBytes(16).toString('base64') }))).toThrow(
      /openssl rand/,
    );
  });

  it('rejects an auth secret with too little entropy', () => {
    expect(() => loadServerEnv(minimal({ BETTER_AUTH_SECRET: 'short' }))).toThrow(/32 characters/);
  });

  it('rejects a malformed URL', () => {
    expect(() => loadServerEnv(minimal({ APP_URL: 'not-a-url' }))).toThrow(/APP_URL/);
    expect(() => loadServerEnv(minimal({ DATABASE_URL: 'localhost:5432' }))).toThrow(/DATABASE_URL/);
  });

  it('coerces the retention window and bounds it', () => {
    expect(loadServerEnv(minimal({ TRANSACTION_RETENTION_MONTHS: '36' })).TRANSACTION_RETENTION_MONTHS).toBe(36);

    resetEnvCache();
    expect(() => loadServerEnv(minimal({ TRANSACTION_RETENTION_MONTHS: '0' }))).toThrow();

    resetEnvCache();
    expect(() => loadServerEnv(minimal({ TRANSACTION_RETENTION_MONTHS: '999' }))).toThrow();
  });

  it('reads the boolean flags in every form a .env produces', () => {
    expect(loadServerEnv(minimal({ FEATURE_PUBLIC_GUIDES: 'true' })).FEATURE_PUBLIC_GUIDES).toBe(true);

    resetEnvCache();
    expect(loadServerEnv(minimal({ FEATURE_PUBLIC_GUIDES: '1' })).FEATURE_PUBLIC_GUIDES).toBe(true);

    resetEnvCache();
    expect(loadServerEnv(minimal({ FEATURE_PUBLIC_GUIDES: 'false' })).FEATURE_PUBLIC_GUIDES).toBe(false);

    resetEnvCache();
    // An empty value in a .env file is the same as "off", not a parse error.
    expect(loadServerEnv(minimal({ FEATURE_PUBLIC_GUIDES: '' })).FEATURE_PUBLIC_GUIDES).toBe(false);
  });

  it('defaults both feature flags to off', () => {
    const env = loadServerEnv(minimal());
    expect(env.FEATURE_PUBLIC_GUIDES).toBe(false);
    expect(env.FEATURE_EMAIL_RECEIPTS).toBe(false);
  });
});

describe('loadServerEnv — cross-field rules', () => {
  /**
   * The specific mistake worth catching: everything boots, the UI offers "Connect a bank", and
   * the failure surfaces as an opaque 400 from Plaid halfway through the Link flow.
   */
  it('refuses AGGREGATOR=plaid without credentials', () => {
    expect(() => loadServerEnv(minimal({ AGGREGATOR: 'plaid' }))).toThrow(/PLAID_CLIENT_ID/);

    resetEnvCache();
    expect(() => loadServerEnv(minimal({ AGGREGATOR: 'plaid', PLAID_CLIENT_ID: 'id' }))).toThrow(
      /PLAID_SECRET/,
    );
  });

  it('accepts AGGREGATOR=plaid with credentials', () => {
    const env = loadServerEnv(
      minimal({ AGGREGATOR: 'plaid', PLAID_CLIENT_ID: 'id', PLAID_SECRET: 'secret' }),
    );
    expect(env.AGGREGATOR).toBe('plaid');
    expect(isFixtureAggregator(env)).toBe(false);
  });

  it('treats the fixture aggregator as the default', () => {
    expect(isFixtureAggregator(loadServerEnv(minimal()))).toBe(true);
  });

  it('requires VAPID keys to be set as a pair', () => {
    expect(() => loadServerEnv(minimal({ VAPID_PUBLIC_KEY: 'pub' }))).toThrow(/together/);

    resetEnvCache();
    expect(() => loadServerEnv(minimal({ VAPID_PRIVATE_KEY: 'priv' }))).toThrow(/together/);

    resetEnvCache();
    expect(() =>
      loadServerEnv(minimal({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' })),
    ).not.toThrow();
  });

  describe('production', () => {
    const production = (overrides: Record<string, string> = {}) =>
      minimal({
        NODE_ENV: 'production',
        APP_URL: 'https://ledger.example.com',
        RESEND_API_KEY: 're_key',
        VAPID_PUBLIC_KEY: 'pub',
        VAPID_PRIVATE_KEY: 'priv',
        ...overrides,
      });

    it('accepts a complete production environment', () => {
      expect(() => loadServerEnv(production())).not.toThrow();
    });

    it('refuses to boot without a mail key, because notifications would silently not send', () => {
      expect(() => loadServerEnv(production({ RESEND_API_KEY: '' }))).toThrow(/RESEND_API_KEY/);
    });

    it('refuses plaintext http, because session cookies are Secure-only', () => {
      expect(() => loadServerEnv(production({ APP_URL: 'http://ledger.example.com' }))).toThrow(
        /https/,
      );
    });

    it('refuses missing VAPID keys', () => {
      expect(() =>
        loadServerEnv(production({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' })),
      ).toThrow(/VAPID/);
    });

    it('does not apply the production rules in development', () => {
      // http, no mail key, no push keys — all fine locally, and that asymmetry is the point.
      expect(() => loadServerEnv(minimal())).not.toThrow();
    });
  });
});

describe('caching', () => {
  it('returns the same object once loaded', () => {
    const first = loadServerEnv(minimal());
    // A second call with a *different* source must not re-read: the environment is fixed at boot,
    // and a mid-process change would mean two halves of the app disagreeing about configuration.
    const second = loadServerEnv(minimal({ AGGREGATOR: 'plaid' }));
    expect(second).toBe(first);
    expect(second.AGGREGATOR).toBe('fixture');
  });

  it('re-reads after a reset', () => {
    loadServerEnv(minimal());
    resetEnvCache();
    const env = loadServerEnv(minimal({ LOG_LEVEL: 'silent' }));
    expect(env.LOG_LEVEL).toBe('silent');
  });
});

describe('loadClientEnv', () => {
  it('accepts a valid public environment', () => {
    expect(loadClientEnv({ NEXT_PUBLIC_APP_URL: 'https://ledger.example.com' })).toEqual({
      NEXT_PUBLIC_APP_URL: 'https://ledger.example.com',
    });
  });

  it('rejects a missing or malformed public app URL', () => {
    expect(() => loadClientEnv({})).toThrow(/NEXT_PUBLIC_APP_URL/);
    expect(() => loadClientEnv({ NEXT_PUBLIC_APP_URL: 'nope' })).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('carries only public values — no server secret has a home in its shape', () => {
    const parsed = loadClientEnv({
      NEXT_PUBLIC_APP_URL: 'https://ledger.example.com',
      // Passing a server secret in must not smuggle it through the parsed result.
      ENCRYPTION_KEY: KEY_32,
      BETTER_AUTH_SECRET: SECRET,
    });

    expect(Object.keys(parsed).every((key) => key.startsWith('NEXT_PUBLIC_'))).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain(KEY_32);
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });
});
