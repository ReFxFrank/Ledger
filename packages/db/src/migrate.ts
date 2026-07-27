/**
 * Migration runner.
 *
 * Separate from drizzle-kit so it can run inside the app container at deploy time with the same
 * connection string the app uses, and so it can create the extensions the schema depends on
 * before the first migration touches them.
 */

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRootEnv } from '@ledger/env';
import { createDatabase } from './client';

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

/**
 * Renders a failure so it always names something actionable.
 *
 * The naive `error.message` produced the least useful log line this project has shipped:
 * "Migration failed: " — nothing after the colon. A dual-stack connect refusal (the classic
 * "DATABASE_URL says localhost inside a container") throws an AggregateError whose own message
 * is empty, with the real ECONNREFUSED entries hidden in `.errors`. Unwrap those, and fall back
 * to the error's name and code when the message is blank.
 */
function describeFailure(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    const parts = error.errors.map((inner) => describeFailure(inner));
    return `${error.message === '' ? 'all connection attempts failed' : error.message} [${parts.join('; ')}]`;
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = error.message === '' ? error.name : error.message;
    return code === undefined ? message : `${message} (${code})`;
  }
  return String(error);
}

async function main(): Promise<void> {
  // A plain Node process starts with none of the repo's configuration. Next loads the root .env
  // for the web app; nothing was loading it here, so `pnpm db:migrate` failed with
  // "DATABASE_URL is not set" while a populated .env sat two directories up.
  loadRootEnv(dirname(fileURLToPath(import.meta.url)));

  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  // A single connection: `migrate` serialises anyway, and a pool here just means more sockets
  // to leak if a migration fails halfway.
  const handle = createDatabase({ url, max: 1, statementTimeoutSeconds: 300 });

  try {
    // pg_trgm backs the merchant similarity index; without it the first migration fails with an
    // opaque "operator class gin_trgm_ops does not exist".
    await handle.sql.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await handle.sql.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    console.log('Applying migrations…');
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.log('Migrations applied.');
  } catch (error) {
    console.error('Migration failed:', describeFailure(error));
    process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

await main();
