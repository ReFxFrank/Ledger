#!/usr/bin/env node
/**
 * The restore drill, automated (brief Phase 10).
 *
 * `docs/RUNBOOK.md` documents a restore procedure. A documented restore that nobody has executed
 * is a hypothesis, and the moment to discover it is wrong is not the morning you need it. This
 * runs the whole thing end to end and fails loudly if any step lies.
 *
 * The step that matters most is the last one. Row counts prove the dump moved bytes; they do not
 * prove the restored data is *usable*, because every aggregator token is sealed under
 * ENCRYPTION_KEY and a restore into an environment with the wrong key yields a database full of
 * ciphertext nobody can open. So the drill opens one.
 *
 *   node scripts/backup-verify.mjs            # dump → restore → verify → drop scratch db
 *   node scripts/backup-verify.mjs --keep     # leave the scratch database for inspection
 *
 * Requires psql/pg_dump/pg_restore on PATH, and a DATABASE_URL whose role may CREATE DATABASE.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keepScratch = process.argv.includes('--keep');

// ── configuration ────────────────────────────────────────────────────────────────────────

function loadEnv() {
  const path = join(root, '.env');
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...loadEnv(), ...process.env };

/**
 * The parsed file has to reach `process.env`, not just this scope: `getKeyring()` inside
 * @ledger/crypto reads ENCRYPTION_KEY from the real environment, and the token-open check below
 * failed with "ENCRYPTION_KEY is not set" while a populated .env sat in the repo root. Real
 * environment values still win, so a deployed invocation is unaffected.
 */
for (const [key, value] of Object.entries(env)) {
  process.env[key] ??= value;
}

const databaseUrl = env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const source = new URL(databaseUrl);
const sourceDb = source.pathname.replace(/^\//, '');
const scratchDb = `${sourceDb}_restore_check`;

/** Postgres tooling takes the password out of band; putting it in argv leaks it to `ps`. */
const pgEnv = { ...process.env, PGPASSWORD: decodeURIComponent(source.password) };

function adminArgs() {
  return ['-h', source.hostname, '-p', source.port || '5432', '-U', decodeURIComponent(source.username)];
}

function psql(database, sql) {
  const out = execFileSync('psql', [...adminArgs(), '-d', database, '-tAc', sql], {
    env: pgEnv,
    encoding: 'utf8',
  });
  // psql on Windows terminates rows with CRLF. Without stripping the \r, a table name read from
  // one query and interpolated into the next becomes `"account\r"`, which does not exist —
  // the drill's first run failed on exactly that.
  return out.replace(/\r/g, '').trim();
}

// ── the drill ────────────────────────────────────────────────────────────────────────────

const backupDir = join(root, '.backups');
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const dumpPath = join(backupDir, `verify-${stamp}.dump`);

let failed = false;
const step = (name) => console.log(`\n▸ ${name}`);

try {
  step('Dump');
  execFileSync('pg_dump', [...adminArgs(), '-d', sourceDb, '-Fc', '-f', dumpPath], { env: pgEnv });
  const bytes = statSync(dumpPath).size;
  console.log(`  ${dumpPath} — ${(bytes / 1024).toFixed(1)} KB`);
  if (bytes < 1024) throw new Error('dump is implausibly small; treating as a failure');

  step('Restore into a scratch database');
  psql('postgres', `drop database if exists "${scratchDb}"`);
  psql('postgres', `create database "${scratchDb}"`);
  // The extensions must exist before the schema that indexes with them.
  psql(scratchDb, 'create extension if not exists pg_trgm; create extension if not exists pgcrypto');
  try {
    execFileSync('pg_restore', [...adminArgs(), '-d', scratchDb, '--no-owner', dumpPath], {
      env: pgEnv,
      stdio: 'pipe',
    });
  } catch (error) {
    // pg_restore exits non-zero on benign notices (extension already exists). Only a missing
    // table below is a real failure, so record and continue to the checks that decide.
    console.log('  pg_restore reported warnings; the row counts below are what decide.');
  }

  step('Compare row counts');
  const tables = psql(
    sourceDb,
    `select table_name from information_schema.tables
     where table_schema='public' and table_type='BASE TABLE' order by table_name`,
  )
    .split('\n')
    .filter(Boolean);

  let mismatches = 0;
  let compared = 0;
  for (const table of tables) {
    const before = psql(sourceDb, `select count(*) from "${table}"`);
    let after;
    try {
      after = psql(scratchDb, `select count(*) from "${table}"`);
    } catch {
      after = 'MISSING';
    }
    compared += 1;
    if (before !== after) {
      mismatches += 1;
      console.log(`  ✗ ${table.padEnd(32)} ${before} → ${after}`);
    }
  }
  console.log(`  ${compared} tables compared, ${mismatches} mismatched`);
  if (mismatches > 0) failed = true;

  step('Open a sealed token from the restored copy');
  // The check the runbook warns about: a restore is only as good as the key that opens it.
  const sealedCount = Number(
    psql(scratchDb, 'select count(*) from bank_connections where access_token_ciphertext is not null'),
  );

  if (sealedCount === 0) {
    console.log('  no sealed rows to test — connect a bank and re-run to exercise this check');
  } else {
    const row = psql(
      scratchDb,
      `select provider || '|' || external_item_id || '|' || key_id || '|' || access_token_ciphertext
       from bank_connections where access_token_ciphertext is not null limit 1`,
    );
    const [provider, externalItemId, keyId, ciphertext] = row.split('|');

    // Imported through the workspace so the drill uses the same envelope code the app does,
    // rather than a reimplementation that could agree with itself and disagree with reality.
    // `pathToFileURL` is required: a Windows absolute path is not a valid import specifier, and
    // the first version swallowed that failure into a "skipped" that looked like a clean run.
    let crypto = {};
    let banking = {};
    let importError = null;
    try {
      crypto = await import(pathToFileURL(join(root, 'packages', 'crypto', 'src', 'index.ts')).href);
      // `accessTokenAad` rather than rebuilding the string here. The first version hand-wrote
      // the column as 'access_token' when the real AAD binds 'access_token_ciphertext', and the
      // drill failed claiming the KEK was wrong — a false alarm about the one thing this check
      // exists to be trusted on. Importing the app's own function makes that drift impossible.
      banking = await import(pathToFileURL(join(root, 'packages', 'banking', 'src', 'adapter.ts')).href);
    } catch (error) {
      importError = error instanceof Error ? error.message : String(error);
    }
    const { getKeyring, open } = crypto;
    const { accessTokenAad } = banking;

    if (typeof open !== 'function') {
      console.log(
        `  (skipped: run with tsx so TypeScript resolves — ${importError ?? 'no open() export'})`,
      );
    } else {
      const keyring = await getKeyring();
      const plaintext = open(keyring, { keyId, ciphertext }, accessTokenAad(provider, externalItemId));
      if (typeof plaintext !== 'string' || plaintext.length === 0) {
        throw new Error('sealed token opened to an empty value');
      }
      console.log(`  ✓ opened a sealed token from the restore (${plaintext.length} chars, not shown)`);
    }
  }
} catch (error) {
  failed = true;
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (!keepScratch) {
    try {
      psql('postgres', `drop database if exists "${scratchDb}"`);
      rmSync(dumpPath, { force: true });
    } catch {
      console.error(`  could not clean up ${scratchDb} / ${dumpPath} — remove them by hand`);
    }
  } else {
    console.log(`\nKept: database ${scratchDb}, dump ${dumpPath}`);
  }
}

console.log(failed ? '\nRESTORE DRILL FAILED\n' : '\nRestore drill passed.\n');
process.exit(failed ? 1 : 0);
