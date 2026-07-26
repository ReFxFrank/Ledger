/**
 * The database connection.
 *
 * One pool per process, created lazily so importing a type from this package does not open a
 * socket. `postgres.js` rather than `pg` because Drizzle's implementation of it handles prepared
 * statements and array types more predictably, and because the transaction API is cleaner.
 */

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export type Database = PostgresJsDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface CreateDatabaseOptions {
  readonly url: string;
  /** Pool size. The worker wants a few; a serverless web process wants one. */
  readonly max?: number;
  /** Statement timeout in seconds. Nothing in this app has any business taking 30s. */
  readonly statementTimeoutSeconds?: number;
  readonly onNotice?: (notice: unknown) => void;
}

export interface DatabaseHandle {
  readonly db: Database;
  readonly sql: postgres.Sql;
  close(): Promise<void>;
}

export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  const client = postgres(options.url, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
    connection: {
      statement_timeout: (options.statementTimeoutSeconds ?? 30) * 1000,
      // Everything in the app reasons in UTC and converts at the edge.
      TimeZone: 'UTC',
    },
    onnotice: options.onNotice ?? (() => undefined),
  });

  return {
    db: drizzle(client, { schema, casing: 'snake_case' }),
    sql: client,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}

let shared: DatabaseHandle | null = null;

/**
 * The process-wide handle.
 *
 * Next dev-mode module reloads would otherwise leak a pool per reload until Postgres refuses
 * connections; caching on `globalThis` is the standard escape hatch and the reason it is here.
 */
export function getDatabase(url: string = requireDatabaseUrl()): DatabaseHandle {
  const globalCache = globalThis as typeof globalThis & { __ledgerDb?: DatabaseHandle };
  if (globalCache.__ledgerDb !== undefined) return globalCache.__ledgerDb;
  if (shared !== null) return shared;

  shared = createDatabase({ url });
  if (process.env['NODE_ENV'] !== 'production') globalCache.__ledgerDb = shared;
  return shared;
}

export async function closeDatabase(): Promise<void> {
  const globalCache = globalThis as typeof globalThis & { __ledgerDb?: DatabaseHandle };
  const handle = globalCache.__ledgerDb ?? shared;
  if (handle === undefined || handle === null) return;
  await handle.close();
  shared = null;
  delete globalCache.__ledgerDb;
}

function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  return url;
}

export { schema };
