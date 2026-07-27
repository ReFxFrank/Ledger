import { defineConfig } from 'drizzle-kit';
import { loadRootEnv } from '@ledger/env';

// drizzle-kit runs as a plain Node process from this package directory, so it sees none of the
// repo's configuration. Same gap as migrate.ts and seed/demo.ts.
//
// No `import.meta.dirname` here: drizzle-kit bundles this config as CJS, where `import.meta` is
// empty and it warns about it. Defaulting to cwd is correct anyway — the loader walks up to the
// workspace root from wherever the command was invoked.
loadRootEnv();

const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  throw new Error('DATABASE_URL is required to run drizzle-kit. Copy .env.example to .env.');
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  casing: 'snake_case',
  verbose: true,
  strict: true,
});
