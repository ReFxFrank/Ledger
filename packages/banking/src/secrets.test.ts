/**
 * Token hygiene.
 *
 * Brief §9: a raw aggregator access token never crosses a package boundary and never reaches a
 * log. That is easy to believe and easy to break, because the way it breaks is not a line
 * somebody wrote — it is a line somebody did *not* write. `throw new Error('sync failed', {
 * cause })` is the whole bug: the cause is an axios error, the axios error carries `config.data`,
 * and `config.data` is the request body that contained the access token.
 *
 * So these tests do not check that we avoided a particular mistake. They serialise everything
 * that leaves the package — the error, its metadata, its cause chain, its stack, and every log
 * line — and assert the token is not in any of it.
 */

import { describe, expect, it } from 'vitest';
import { ItemUpdateTypeEnum } from 'plaid';
import { FixedClock } from '@ledger/core';
import { Keyring, keyFromBase64, open, seal } from '@ledger/crypto';
import type { Logger } from '@ledger/logger';

import {
  type AggregatorConnection,
  type AggregatorError,
  accessTokenAad,
  isAggregatorError,
} from './adapter';
import { FixtureAdapter } from './fixture-adapter';
import { MemorySyncStore } from './memory-store';
import { type PlaidClient, PlaidAdapter } from './plaid-adapter';
import { syncConnection } from './sync';

const ACCESS_TOKEN = 'access-sandbox-11111111-2222-3333-4444-555555555555';
const NOW = '2026-07-20T09:00:00Z';

function keyring(): Keyring {
  return new Keyring(keyFromBase64(Buffer.alloc(32, 11).toString('base64')));
}

/**
 * Everything an operator or a log aggregator could ever see of a thrown value.
 *
 * Deliberately exhaustive — `cause` in particular, because that is the field a well-meaning
 * `{ cause }` would put an axios error into.
 */
function everythingVisible(value: unknown, depth = 0): string {
  if (depth > 6) return '';
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // Symbols and functions cannot carry a token in a form a log would print.
  if (typeof value !== 'object') return '';

  const parts: string[] = [];
  if (value instanceof Error) {
    parts.push(value.name, value.message, value.stack ?? '');
    parts.push(everythingVisible(value.cause, depth + 1));
  }
  if (isAggregatorError(value)) parts.push(safeStringify(value.meta));
  parts.push(safeStringify(value));
  for (const nested of Object.values(value)) parts.push(everythingVisible(nested, depth + 1));
  return parts.join('\n');
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[circular]';
        seen.add(item);
      }
      return item;
    }) ?? ''
  );
}

/** A `PlaidClient` whose every method rejects unless a test replaces it. */
function stubClient(overrides: Partial<PlaidClient>): PlaidClient {
  const reject =
    (name: string) =>
    (): Promise<never> =>
      Promise.reject(new Error(`${name} is not stubbed`));

  const base: PlaidClient = {
    linkTokenCreate: reject('linkTokenCreate'),
    itemPublicTokenExchange: reject('itemPublicTokenExchange'),
    itemGet: reject('itemGet'),
    institutionsGetById: reject('institutionsGetById'),
    transactionsSync: reject('transactionsSync'),
    accountsGet: reject('accountsGet'),
    itemRemove: reject('itemRemove'),
    webhookVerificationKeyGet: reject('webhookVerificationKeyGet'),
  };

  return { ...base, ...overrides };
}

/**
 * The failure the Plaid SDK actually produces: an axios error whose `config.data` is the request
 * body — which, on every endpoint this adapter calls, contains the access token.
 */
function axiosLikeFailure(): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    name: 'AxiosError',
    config: {
      url: 'https://sandbox.plaid.com/transactions/sync',
      data: JSON.stringify({ access_token: ACCESS_TOKEN, count: 250 }),
      headers: { 'PLAID-SECRET': 'plaid-secret-value' },
    },
    request: { _header: `POST /transactions/sync\naccess_token: ${ACCESS_TOKEN}` },
    response: {
      status: 400,
      data: {
        error_type: 'ITEM_ERROR',
        error_code: 'ITEM_LOGIN_REQUIRED',
        error_message: 'the login details of this item have changed',
        request_id: 'req-abc123',
      },
      config: { data: JSON.stringify({ access_token: ACCESS_TOKEN }) },
    },
  });
}

function sealedConnection(ring: Keyring): AggregatorConnection {
  const sealed = seal(ring, ACCESS_TOKEN, accessTokenAad('plaid', 'item-1'));
  return {
    id: 'conn-1',
    provider: 'plaid',
    externalItemId: 'item-1',
    accessTokenCiphertext: sealed.ciphertext,
    keyId: sealed.keyId,
  };
}

describe('the access token never reaches an error', () => {
  it('is absent from a sanitised upstream failure, cause chain included', async () => {
    const ring = keyring();
    const adapter = new PlaidAdapter({
      keyring: ring,
      clock: new FixedClock(NOW),
      client: stubClient({ transactionsSync: () => Promise.reject(axiosLikeFailure()) }),
    });

    let thrown: unknown;
    try {
      await adapter.syncTransactions(sealedConnection(ring), null);
    } catch (cause) {
      thrown = cause;
    }

    expect(isAggregatorError(thrown)).toBe(true);
    expect((thrown as AggregatorError).aggregatorCode).toBe('reauth_required');

    const visible = everythingVisible(thrown);
    expect(visible).not.toContain(ACCESS_TOKEN);
    expect(visible).not.toContain('access_token');
    expect(visible).not.toContain('plaid-secret-value');
    // The useful part survived: an operator can still find this request in Plaid's dashboard.
    expect(visible).toContain('req-abc123');
  });

  it('is absent when the failure has no structured body at all', async () => {
    const ring = keyring();
    const adapter = new PlaidAdapter({
      keyring: ring,
      clock: new FixedClock(NOW),
      client: stubClient({
        accountsGet: () =>
          Promise.reject(
            Object.assign(new Error('socket hang up'), {
              config: { data: JSON.stringify({ access_token: ACCESS_TOKEN }) },
            }),
          ),
      }),
    });

    await expect(adapter.getAccounts(sealedConnection(ring))).rejects.toThrow();
    const thrown = await adapter.getAccounts(sealedConnection(ring)).catch((cause: unknown) => cause);
    expect(everythingVisible(thrown)).not.toContain(ACCESS_TOKEN);
  });

  it('is absent when the envelope cannot be opened', async () => {
    const adapter = new PlaidAdapter({
      keyring: keyring(),
      clock: new FixedClock(NOW),
      client: stubClient({}),
    });

    const thrown = await adapter
      .getAccounts({
        id: 'conn-1',
        provider: 'plaid',
        externalItemId: 'item-1',
        // Sealed under a different key: the open fails, and the failure must not describe what
        // it was trying to open.
        accessTokenCiphertext: seal(
          new Keyring(keyFromBase64(Buffer.alloc(32, 12).toString('base64'))),
          ACCESS_TOKEN,
          accessTokenAad('plaid', 'item-1'),
        ).ciphertext,
        keyId: 'some-other-key',
      })
      .catch((cause: unknown) => cause);

    expect(isAggregatorError(thrown)).toBe(true);
    expect(everythingVisible(thrown)).not.toContain(ACCESS_TOKEN);
  });
});

describe('the access token never leaves an adapter method', () => {
  it('is returned sealed by exchangeToken and nowhere else', async () => {
    const ring = keyring();
    const adapter = new PlaidAdapter({
      keyring: ring,
      clock: new FixedClock(NOW),
      client: stubClient({
        itemPublicTokenExchange: () =>
          Promise.resolve({
            data: { access_token: ACCESS_TOKEN, item_id: 'item-1', request_id: 'req-1' },
          }),
        itemGet: () =>
          Promise.resolve({
            data: {
              item: {
                item_id: 'item-1',
                institution_id: 'ins_3',
                webhook: null,
                error: null,
                available_products: [],
                billed_products: [],
                consent_expiration_time: '2026-10-18T09:00:00Z',
                update_type: ItemUpdateTypeEnum.Background,
              },
              request_id: 'req-2',
              status: null,
            },
          }),
        institutionsGetById: () =>
          Promise.resolve({
            data: {
              institution: {
                institution_id: 'ins_3',
                name: 'Chase',
                products: [],
                country_codes: [],
                routing_numbers: [],
                oauth: false,
              },
              request_id: 'req-3',
            },
          }),
      }),
    });

    const linked = await adapter.exchangeToken('public-sandbox-1');

    expect(safeStringify(linked)).not.toContain(ACCESS_TOKEN);
    expect(linked.institutionName).toBe('Chase');
    expect(linked.consentExpiresAt?.toISOString()).toBe('2026-10-18T09:00:00.000Z');
    // Sealed, not encoded: the ciphertext really is the token and really is protected.
    expect(
      open(
        ring,
        { keyId: linked.keyId, ciphertext: linked.accessTokenCiphertext },
        accessTokenAad('plaid', 'item-1'),
      ),
    ).toBe(ACCESS_TOKEN);
  });
});

describe('nothing secret reaches a log', () => {
  it('logs a whole sync without emitting a token or a ciphertext', async () => {
    const lines: unknown[] = [];
    const capture = {
      level: 'trace',
      fatal: (value: unknown) => lines.push(value),
      error: (value: unknown) => lines.push(value),
      warn: (value: unknown) => lines.push(value),
      info: (value: unknown) => lines.push(value),
      debug: (value: unknown) => lines.push(value),
      trace: (value: unknown) => lines.push(value),
      child: () => capture,
    };
    const logger = capture as unknown as Logger;

    const ring = keyring();
    const clock = new FixedClock(NOW);
    const adapter = new FixtureAdapter({ clock, keyring: ring, seed: 77, pageSize: 200 });
    const linked = await adapter.exchangeToken('public-fixture-1');

    const store = new MemorySyncStore();
    store.seedConnection({
      id: 'conn-1',
      userId: 'user-1',
      provider: 'fixture',
      externalItemId: linked.externalItemId,
      accessTokenCiphertext: linked.accessTokenCiphertext,
      keyId: linked.keyId,
    });

    const context = { adapter, store, clock, logger };
    await syncConnection(context, { userId: 'user-1', connectionId: 'conn-1' });

    // And once more through the failure path, which is where a cause chain would otherwise be
    // handed to the logger wholesale.
    store.onPage = () => {
      throw new Error('bank went away');
    };
    await expect(
      syncConnection(context, { userId: 'user-1', connectionId: 'conn-1' }),
    ).rejects.toThrow();

    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.map((line) => safeStringify(line)).join('\n');
    expect(logged).not.toContain('fixture-access');
    expect(logged).not.toContain(linked.accessTokenCiphertext);
    expect(logged).not.toContain('accessTokenCiphertext');
  });
});
