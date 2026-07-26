/**
 * @ledger/db — schema, connection, state machines, and the scoping helper.
 *
 * The schema is the frozen contract (brief §0.2). Everything downstream imports its types from
 * here rather than restating them.
 */

export * from './schema/index';
export * from './state/index';
export {
  Scope,
  USER_SCOPED_TABLES,
  type ScopedExecutor,
  type UserScopedTable,
  scoped,
} from './scope';
export {
  type CreateDatabaseOptions,
  type Database,
  type DatabaseHandle,
  type Transaction,
  closeDatabase,
  createDatabase,
  getDatabase,
} from './client';
