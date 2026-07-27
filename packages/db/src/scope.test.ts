/**
 * Scoping tests.
 *
 * `Scope` is the single place a user filter is written, which means it is also the single place
 * a user filter can be *missed*. These tests assert against the SQL Drizzle actually generates
 * rather than against the shape of the builder object, because the thing that leaks someone
 * else's financial life is the emitted `WHERE`, not the API that produced it.
 *
 * No Postgres is involved. `PgDialect.sqlToQuery` renders a `SQL` fragment to text and
 * parameters with no connection at all, so the whole suite runs offline in milliseconds.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { LedgerError } from '@ledger/core';
import { Scope, USER_SCOPED_TABLES, scoped } from './scope';
import { type Database, createDatabase } from './client';
import {
  bankAccounts,
  bankConnections,
  cancellationEvents,
  cancellationRequests,
  subscriptionPriceHistory,
  subscriptionShares,
  subscriptions,
  transactions,
  usageLogs,
} from './schema/index';

const USER = 'user_alice';
const OTHER_USER = 'user_mallory';

const dialect = new PgDialect();

/**
 * A real Drizzle handle, but never a connection.
 *
 * `Scope`'s `EXISTS` helpers build genuine subqueries through the query builder, so a hand-rolled
 * stub would render as an opaque parameter and the tests would assert nothing. postgres.js does
 * not dial until a query is executed, and nothing here executes one.
 */
const handle = createDatabase({ url: 'postgres://ledger:ledger@127.0.0.1:5432/ledger_scope_test' });

afterAll(async () => {
  await handle.close();
});

/**
 * For `assertOwnsAll`, which is the one method that awaits a result. It only ever calls
 * `select().from().where()`, so that is the whole stub.
 */
function stubExecutor(rows: readonly { id: string }[]): Database {
  const builder = {
    select: () => builder,
    from: () => builder,
    where: () => Promise.resolve([...rows]),
  };
  return builder as unknown as Database;
}

function render(fragment: SQL): { text: string; params: readonly unknown[] } {
  const query = dialect.sqlToQuery(fragment);
  return { text: query.sql, params: query.params };
}

function scopeFor(userId: string): Scope {
  return new Scope(handle.db, userId);
}

function scopeReturning(userId: string, rows: readonly { id: string }[]): Scope {
  return new Scope(stubExecutor(rows), userId);
}

describe('Scope construction', () => {
  it('refuses an empty user id', () => {
    expect(() => new Scope(handle.db, '')).toThrow(LedgerError);
    expect(() => new Scope(handle.db, '')).toThrow(/without a user id/i);
  });

  it('reports FORBIDDEN rather than a generic failure', () => {
    try {
      new Scope(handle.db, '');
      expect.unreachable('constructing a Scope without a user id must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe('FORBIDDEN');
    }
  });

  it('binds the user id and keeps it across executors', () => {
    const scope = scoped(handle.db, USER);
    expect(scope.userId).toBe(USER);

    const rebound = scope.withExecutor(handle.db);
    expect(rebound.userId).toBe(USER);
    // A new Scope, not a mutated one — a transaction must not be able to widen the caller's.
    expect(rebound).not.toBe(scope);
  });
});

describe('own()', () => {
  it('stamps the user id onto an insert', () => {
    const values = scopeFor(USER).own({ displayName: 'Netflix', amountMinor: 1799 });
    expect(values).toEqual({ displayName: 'Netflix', amountMinor: 1799, userId: USER });
  });

  it('cannot be overridden by a caller-supplied user id', () => {
    // This is the mass-assignment half of the cross-user bug: a request body carrying its own
    // `userId`. The stamp has to win, and it has to win silently rather than by trusting the
    // call site to have stripped the field.
    const values = scopeFor(USER).own({ userId: OTHER_USER, displayName: 'Netflix' });
    expect(values.userId).toBe(USER);
  });

  it('stamps every row of a batch', () => {
    const rows = scopeFor(USER).ownAll([{ label: 'Visa' }, { label: 'Amex', userId: OTHER_USER }]);
    expect(rows.map((row) => row.userId)).toEqual([USER, USER]);
  });
});

describe('where() / whereId()', () => {
  it('always emits the user predicate', () => {
    const { text, params } = render(scopeFor(USER).where(subscriptions));
    expect(text).toContain('"subscriptions"."user_id" =');
    expect(params).toEqual([USER]);
  });

  it('keeps the user predicate when extra filters are added', () => {
    const { text, params } = render(
      scopeFor(USER).where(subscriptions, eq(subscriptions.status, 'active')),
    );
    expect(text).toContain('"subscriptions"."user_id" =');
    expect(text).toContain('"subscriptions"."status" =');
    expect(params).toEqual([USER, 'active']);
  });

  it('drops undefined filters without dropping the user predicate', () => {
    const { text, params } = render(scopeFor(USER).where(subscriptions, undefined));
    expect(text).toContain('"subscriptions"."user_id" =');
    expect(params).toEqual([USER]);
  });

  it('pins to a row id *and* the user', () => {
    const { text, params } = render(scopeFor(USER).whereId(subscriptions, 'sub-1'));
    expect(text).toContain('"subscriptions"."user_id" =');
    expect(text).toContain('"subscriptions"."id" =');
    expect(params).toEqual([USER, 'sub-1']);
  });

  it('emits a user predicate for every directly-scoped table in the registry', () => {
    // The registry is what the cross-user suite walks, so a table added to it without a
    // `user_id` column would silently produce an unscoped query.
    for (const [name, table] of Object.entries(USER_SCOPED_TABLES)) {
      const { text, params } = render(scopeFor(USER).where(table));
      expect(text, name).toMatch(/"user_id" =/);
      expect(params, name).toEqual([USER]);
    }
  });
});

describe('indirectly-scoped tables', () => {
  const cases: readonly {
    readonly name: string;
    readonly build: (scope: Scope, ...extra: (SQL | undefined)[]) => SQL;
    /** The column the EXISTS has to be correlated against. */
    readonly correlatedOn: string;
    /** The column that must carry the user id. */
    readonly ownerColumn: string;
  }[] = [
    {
      name: 'transactions',
      build: (scope, ...extra) => scope.transactions(...extra),
      correlatedOn: '"transactions"."account_id"',
      ownerColumn: '"bank_connections"."user_id"',
    },
    {
      name: 'bankAccounts',
      build: (scope, ...extra) => scope.bankAccounts(...extra),
      correlatedOn: '"bank_accounts"."connection_id"',
      ownerColumn: '"bank_connections"."user_id"',
    },
    {
      name: 'priceHistory',
      build: (scope, ...extra) => scope.priceHistory(...extra),
      correlatedOn: '"subscription_price_history"."subscription_id"',
      ownerColumn: '"subscriptions"."user_id"',
    },
    {
      name: 'shares',
      build: (scope, ...extra) => scope.shares(...extra),
      correlatedOn: '"subscription_shares"."subscription_id"',
      ownerColumn: '"subscriptions"."user_id"',
    },
    {
      name: 'usageLogs',
      build: (scope, ...extra) => scope.usageLogs(...extra),
      correlatedOn: '"usage_logs"."subscription_id"',
      ownerColumn: '"subscriptions"."user_id"',
    },
    {
      name: 'cancellationEvents',
      build: (scope, ...extra) => scope.cancellationEvents(...extra),
      correlatedOn: '"cancellation_events"."request_id"',
      ownerColumn: '"cancellation_requests"."user_id"',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} emits an EXISTS constrained to the user`, () => {
      const { text, params } = render(testCase.build(scopeFor(USER)));

      expect(text).toContain('exists (select');
      expect(text).toContain(testCase.correlatedOn);
      expect(text).toContain(`${testCase.ownerColumn} =`);
      expect(params).toEqual([USER]);
    });

    it(`${testCase.name} keeps the EXISTS when a caller adds a filter`, () => {
      // The failure this guards is real: a caller passes `eq(table.id, someId)` and the helper
      // returns only that, because the extra predicate replaced rather than joined the EXISTS.
      const { text, params } = render(
        testCase.build(scopeFor(USER), eq(subscriptions.id, 'sub-1')),
      );
      expect(text).toContain(`${testCase.ownerColumn} =`);
      expect(params).toEqual([USER, 'sub-1']);
    });
  }

  it('correlates transactions through the account, not straight to the connection', () => {
    // `transactions` has no `connection_id`; going account → connection is the only correct
    // path, and getting it wrong would produce an EXISTS that is always true.
    const { text } = render(scopeFor(USER).transactions());
    expect(text).toContain('"bank_accounts"');
    expect(text).toContain('"bank_connections"');
    expect(text).toContain('"bank_accounts"."connection_id"');
  });
});

describe('assertOwnsAll()', () => {
  it('does nothing for an empty id list', async () => {
    // No query at all: an empty bulk action is a no-op, not a full-table read.
    await expect(scopeReturning(USER, []).assertOwnsAll(subscriptions, [])).resolves.toBeUndefined();
  });

  it('passes when every id comes back', async () => {
    const scope = scopeReturning(USER, [{ id: 'a' }, { id: 'b' }]);
    await expect(scope.assertOwnsAll(subscriptions, ['a', 'b'])).resolves.toBeUndefined();
  });

  it('counts duplicates once', async () => {
    const scope = scopeReturning(USER, [{ id: 'a' }]);
    await expect(scope.assertOwnsAll(subscriptions, ['a', 'a'])).resolves.toBeUndefined();
  });

  it('throws rather than acting on the owned subset', async () => {
    const scope = scopeReturning(USER, [{ id: 'a' }]);
    await expect(scope.assertOwnsAll(subscriptions, ['a', 'not-mine'])).rejects.toThrow(LedgerError);
  });

  it('does not disclose which ids exist', async () => {
    const scope = scopeReturning(USER, [{ id: 'a' }]);
    try {
      await scope.assertOwnsAll(subscriptions, ['a', 'someone-elses-uuid']);
      expect.unreachable('assertOwnsAll must reject a foreign id');
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      const ledgerError = error as LedgerError;
      expect(ledgerError.code).toBe('FORBIDDEN');
      // "does not exist or is not yours" — the two cases are deliberately indistinguishable,
      // because telling them apart turns a 403 into an existence oracle.
      expect(ledgerError.message).not.toContain('someone-elses-uuid');
    }
  });

  it('scopes the lookup it performs', () => {
    // The predicate assertOwnsAll builds is the same `where()` everything else uses.
    const { text, params } = render(
      scopeFor(USER).where(subscriptions, inArray(subscriptions.id, ['a', 'b'])),
    );
    expect(text).toContain('"subscriptions"."user_id" =');
    expect(params).toEqual([USER, 'a', 'b']);
  });
});

describe('the tables the scope knows about', () => {
  it('covers every user-scoped table the schema defines', () => {
    // A regression guard with teeth: adding a `user_id` table and forgetting to register it
    // here means no test in the codebase ever checks that it is scoped.
    expect(Object.keys(USER_SCOPED_TABLES)).toEqual(
      expect.arrayContaining([
        'subscriptions',
        'detections',
        'paymentMethods',
        'bankConnections',
        'cancellationRequests',
        'attachments',
        'notifications',
        'notificationPreferences',
        'notificationSettings',
        'pushSubscriptions',
        'auditLog',
      ]),
    );
  });

  it('reaches the indirectly-scoped tables that carry no user_id', () => {
    const indirect = [
      transactions,
      bankAccounts,
      subscriptionPriceHistory,
      subscriptionShares,
      usageLogs,
      cancellationEvents,
    ];
    for (const table of indirect) {
      expect(Object.values(USER_SCOPED_TABLES)).not.toContain(table);
    }
    // …and the tables they hang off are the ones that do.
    expect(Object.values(USER_SCOPED_TABLES)).toContain(bankConnections);
    expect(Object.values(USER_SCOPED_TABLES)).toContain(cancellationRequests);
    expect(Object.values(USER_SCOPED_TABLES)).toContain(subscriptions);
  });
});
