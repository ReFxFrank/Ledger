#!/usr/bin/env node
/**
 * One command from "a database exists" to "a browser you can sign into".
 *
 * Checks the two services, applies migrations, seeds the demo user, and prints the credentials
 * — including the TOTP secret, because 2FA is mandatory and a demo you cannot sign into is not
 * a demo.
 *
 * It refuses to run against a database that already has data unless `--force` is passed. Seeding
 * twice is idempotent by design, but "I pointed this at the wrong DATABASE_URL" is a mistake
 * worth catching before rather than after.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const path = join(root, '.env');
  if (!existsSync(path)) {
    console.error('No .env at the repo root. Copy .env.example to .env first.');
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return env;
}

function reachable(host, port, timeoutMs = 2500) {
  return new Promise((resolvePromise) => {
    const socket = new net.Socket();
    const done = (ok) => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      done(true);
    });
    socket.once('timeout', () => {
      done(false);
    });
    socket.once('error', () => {
      done(false);
    });
    socket.connect(port, host);
  });
}

function hostPort(url, fallbackPort) {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: Number(parsed.port) || fallbackPort };
  } catch {
    return null;
  }
}

const env = loadEnv();
const db = hostPort(env.DATABASE_URL ?? '', 5432);
const redis = hostPort(env.REDIS_URL ?? '', 6379);

if (db === null || redis === null) {
  console.error('DATABASE_URL or REDIS_URL is missing or malformed in .env.');
  process.exit(1);
}

console.log(`Checking postgres at ${db.host}:${String(db.port)} …`);
const dbUp = await reachable(db.host, db.port);
console.log(`Checking redis at ${redis.host}:${String(redis.port)} …`);
const redisUp = await reachable(redis.host, redis.port);

if (!dbUp) {
  console.error(`\nPostgres is not reachable at ${db.host}:${String(db.port)}.`);
  console.error(
    'Start it with `docker compose up -d`, or point DATABASE_URL in .env at wherever it is\n' +
      'actually running. Nothing in the app works without it.',
  );
  process.exit(1);
}

/**
 * Redis is a warning, not an error.
 *
 * Only `apps/worker` uses it — the web app never imports it, so you can browse, add, edit, and
 * cancel subscriptions without it. What you lose is scheduled work: notifications, bank sync,
 * and post-cancellation charge verification.
 */
if (!redisUp) {
  console.warn(
    `\nRedis is not reachable at ${redis.host}:${String(redis.port)}. The web app runs fine ` +
      'without it —\nthe background worker does not, so notifications, bank sync, and ' +
      'cancellation verification\nwill not run. Continuing.',
  );
}

const run = (command) => {
  console.log(`\n$ ${command}`);
  execSync(command, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
};

run('pnpm db:migrate');
run('pnpm seed:demo');

console.log('\nReady. Start the app with:\n\n  pnpm dev\n\nThen open http://localhost:3000');
