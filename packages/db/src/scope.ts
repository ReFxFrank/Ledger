/**
 * User scoping.
 *
 * Brief §5: "All user-scoped tables carry `user_id` and are filtered in a single query-builder
 * helper — never hand-roll the scope filter at call sites."
 *
 * The failure this prevents is not exotic. It is one query, written in a hurry, that filters by
 * `subscriptionId` and forgets `userId` — and now anyone who can guess a UUID reads someone
 * else's financial life. So no call site in this codebase ever writes `eq(table.userId, ...)`.
 * They ask a `Scope` for a predicate, and the predicate is always there.
 *
 * Tables that do not carry `user_id` directly — transactions, bank accounts, cancellation
 * events, price history — get explicit `EXISTS` predicates here rather than being left to a
 * join a caller might forget to constrain.
 */

import { and, eq, exists, inArray, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { LedgerError } from '@ledger/core';
import type { Database, Transaction } from './client';
import {
  attachments,
  auditLog,
  bankAccounts,
  bankConnections,
  cancellationEvents,
  cancellationRequests,
  detections,
  notificationPreferences,
  notificationSettings,
  notifications,
  paymentMethods,
  pushSubscriptions,
  subscriptionPriceHistory,
  subscriptionShares,
  subscriptions,
  transactions,
  usageLogs,
} from './schema/index';

/** A table that carries `user_id` itself. */
export type UserScopedTable = PgTable & { userId: PgColumn };

/**
 * The registry of directly-scoped tables.
 *
 * Exported because the cross-user access test suite (brief §9.3) walks it: every table here is
 * expected to be unreachable across users through every procedure that touches it.
 */
export const USER_SCOPED_TABLES = {
  subscriptions,
  detections,
  paymentMethods,
  bankConnections,
  cancellationRequests,
  attachments,
  notifications,
  notificationPreferences,
  notificationSettings,
  pushSubscriptions,
  auditLog,
} as const satisfies Record<string, UserScopedTable>;

export type ScopedExecutor = Database | Transaction;

/**
 * Binds a user id to a query surface.
 *
 * Construct one per request from the authenticated session and pass it down. There is
 * deliberately no way to build one without a user id, and no way to widen it afterwards.
 */
export class Scope {
  constructor(
    readonly db: ScopedExecutor,
    readonly userId: string,
  ) {
    if (userId === '') {
      throw new LedgerError('FORBIDDEN', 'Cannot build a Scope without a user id.');
    }
  }

  /** Re-binds this scope onto a transaction, keeping the same user. */
  withExecutor(executor: ScopedExecutor): Scope {
    return new Scope(executor, this.userId);
  }

  /**
   * The predicate for a directly-scoped table, ANDed with anything else the caller needs.
   *
   * `undefined` entries are dropped, so `scope.where(subscriptions, maybeFilter)` works without
   * the caller building an array conditionally.
   */
  where(table: UserScopedTable, ...extra: (SQL | undefined)[]): SQL {
    const predicate = and(eq(table.userId, this.userId), ...extra);
    // `and()` only returns undefined when given nothing; the first argument guarantees one.
    if (predicate === undefined) throw new LedgerError('FORBIDDEN', 'Scope predicate collapsed.');
    return predicate;
  }

  /** Same, but also pinned to a row id — the shape almost every detail query wants. */
  whereId(
    table: UserScopedTable & { id: PgColumn },
    id: string,
    ...extra: (SQL | undefined)[]
  ): SQL {
    return this.where(table, eq(table.id, id), ...extra);
  }

  // ── indirectly-scoped tables ──────────────────────────────────────────────────────────

  /** `transactions` belongs to a user through account → connection. */
  transactions(...extra: (SQL | undefined)[]): SQL {
    const predicate = and(
      exists(
        this.db
          .select({ one: bankAccounts.id })
          .from(bankAccounts)
          .innerJoin(bankConnections, eq(bankAccounts.connectionId, bankConnections.id))
          .where(and(eq(bankAccounts.id, transactions.accountId), eq(bankConnections.userId, this.userId))),
      ),
      ...extra,
    );
    if (predicate === undefined) throw new LedgerError('FORBIDDEN', 'Scope predicate collapsed.');
    return predicate;
  }

  /** `bank_accounts` belongs to a user through its connection. */
  bankAccounts(...extra: (SQL | undefined)[]): SQL {
    const predicate = and(
      exists(
        this.db
          .select({ one: bankConnections.id })
          .from(bankConnections)
          .where(
            and(eq(bankConnections.id, bankAccounts.connectionId), eq(bankConnections.userId, this.userId)),
          ),
      ),
      ...extra,
    );
    if (predicate === undefined) throw new LedgerError('FORBIDDEN', 'Scope predicate collapsed.');
    return predicate;
  }

  /** Anything hanging off a subscription: price history, shares, usage. */
  private viaSubscription(column: PgColumn, extra: (SQL | undefined)[]): SQL {
    const predicate = and(
      exists(
        this.db
          .select({ one: subscriptions.id })
          .from(subscriptions)
          .where(and(eq(subscriptions.id, column), eq(subscriptions.userId, this.userId))),
      ),
      ...extra,
    );
    if (predicate === undefined) throw new LedgerError('FORBIDDEN', 'Scope predicate collapsed.');
    return predicate;
  }

  priceHistory(...extra: (SQL | undefined)[]): SQL {
    return this.viaSubscription(subscriptionPriceHistory.subscriptionId, extra);
  }

  shares(...extra: (SQL | undefined)[]): SQL {
    return this.viaSubscription(subscriptionShares.subscriptionId, extra);
  }

  usageLogs(...extra: (SQL | undefined)[]): SQL {
    return this.viaSubscription(usageLogs.subscriptionId, extra);
  }

  /** `cancellation_events` belongs to a user through its request. */
  cancellationEvents(...extra: (SQL | undefined)[]): SQL {
    const predicate = and(
      exists(
        this.db
          .select({ one: cancellationRequests.id })
          .from(cancellationRequests)
          .where(
            and(
              eq(cancellationRequests.id, cancellationEvents.requestId),
              eq(cancellationRequests.userId, this.userId),
            ),
          ),
      ),
      ...extra,
    );
    if (predicate === undefined) throw new LedgerError('FORBIDDEN', 'Scope predicate collapsed.');
    return predicate;
  }

  // ── writes ────────────────────────────────────────────────────────────────────────────

  /**
   * Stamps `userId` onto an insert.
   *
   * Takes the values without a `userId` field at all, so a caller cannot pass someone else's —
   * mass-assignment from a request body is the other half of the cross-user bug.
   */
  own<V extends Record<string, unknown>>(values: V): V & { userId: string } {
    return { ...values, userId: this.userId };
  }

  ownAll<V extends Record<string, unknown>>(rows: readonly V[]): (V & { userId: string })[] {
    return rows.map((row) => this.own(row));
  }

  /**
   * Confirms a set of ids all belong to this user before acting on them.
   *
   * Bulk operations — "archive these 12" — are where scoping most often slips, because the ids
   * arrive as an array from the client and the update is written as `inArray(table.id, ids)`.
   * This throws rather than silently operating on the subset that happens to be owned, because a
   * partial bulk action the user did not ask for is its own kind of wrong.
   */
  async assertOwnsAll(
    table: UserScopedTable & { id: PgColumn },
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const rows = await this.db
      .select({ id: table.id })
      .from(table)
      .where(this.where(table, inArray(table.id, [...ids])));

    if (rows.length !== new Set(ids).size) {
      const found = new Set(rows.map((row) => row.id));
      const missing = [...new Set(ids)].filter((id) => !found.has(id));
      throw new LedgerError('FORBIDDEN', 'Some of those records do not exist or are not yours.', {
        meta: { missingCount: missing.length },
      });
    }
  }
}

export function scoped(db: ScopedExecutor, userId: string): Scope {
  return new Scope(db, userId);
}
