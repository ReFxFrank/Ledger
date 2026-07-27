#!/usr/bin/env node
/**
 * Brief §9.7 — "Add a CI check that greps the built client for known env var names."
 *
 * Two scans, because the name scan alone is both too weak and too noisy:
 *
 *  1. **Value scan (the real test).** For every server-only variable that actually has a value in
 *     this environment, search the client bundle for that literal. A hit means a secret is in
 *     JavaScript we ship to browsers. There is no legitimate reason for this and no allowlist.
 *
 *  2. **Name scan (intent).** Search for the variable names. This catches a `process.env.SECRET`
 *     written in a client component before it ever holds a real value — worth failing on, because
 *     it is the shape of the bug rather than the bug itself.
 *
 * The name scan needs an allowlist and the value scan does not. Isomorphic libraries ship an env
 * accessor whose *keys* are string literals in the bundle — better-auth's is a frozen object of
 * lazy getters over `process.env[name]`, which resolves to undefined in a browser. That is a
 * mention of the name, not a disclosure of the value. Allowlisted names are still fully subject
 * to the value scan, so an actual leak of an allowlisted variable still fails the build.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = join(root, 'apps', 'web', '.next', 'static');

/** Public by construction, or too generic to be signal. */
const NOT_SECRET = new Set(['NODE_ENV', 'LOG_LEVEL', 'PLAID_ENV', 'EMAIL_FROM']);

/**
 * Names permitted to APPEAR in the bundle as string literals, with the reason.
 * Their values are still checked. Adding an entry here requires establishing that the value is
 * absent — which the value scan then enforces on every subsequent build.
 */
const NAME_ALLOWLIST = new Map([
  [
    'BETTER_AUTH_SECRET',
    "better-auth's isomorphic env accessor lists it as a lazy getter key; resolves to undefined in a browser",
  ],
  [
    'BETTER_AUTH_URL',
    "better-auth's isomorphic env accessor lists it as a lazy getter key; resolves to undefined in a browser",
  ],
]);

/**
 * Values too short or too common to search for without drowning in false positives.
 * A secret this short is its own problem, and the env schema already rejects the ones that matter.
 */
const MIN_VALUE_LENGTH = 12;

function parseEnvFile(path) {
  if (!existsSync(path)) return new Map();
  const entries = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    entries.set(name, value);
  }
  return entries;
}

function serverOnlyNames(declared) {
  return [...declared.keys()].filter(
    (name) => !name.startsWith('NEXT_PUBLIC_') && !NOT_SECRET.has(name),
  );
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(js|mjs|json|txt|map)$/.test(entry)) yield full;
  }
}

if (!existsSync(clientDir)) {
  console.error(`No client bundle at ${clientDir}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const declared = parseEnvFile(join(root, '.env.example'));
const names = serverOnlyNames(declared);

// Real values come from the live environment, falling back to a local .env. In CI the process
// environment carries them; locally the .env file does.
const live = parseEnvFile(join(root, '.env'));
const secrets = names
  .map((name) => ({ name, value: process.env[name] ?? live.get(name) ?? '' }))
  .filter(({ value }) => value.length >= MIN_VALUE_LENGTH);

const valueLeaks = [];
const nameHits = [];

for (const file of walk(clientDir)) {
  const content = readFileSync(file, 'utf8');
  const relative = file.slice(root.length + 1);

  for (const { name, value } of secrets) {
    if (content.includes(value)) valueLeaks.push({ name, file: relative });
  }

  for (const name of names) {
    if (content.includes(name)) nameHits.push({ name, file: relative });
  }
}

let failed = false;

if (valueLeaks.length > 0) {
  failed = true;
  console.error('SECRET VALUES FOUND IN THE CLIENT BUNDLE:\n');
  for (const { name, file } of valueLeaks) console.error(`  ${name}  →  ${file}`);
  console.error(
    '\nThe value of a server-only variable is in JavaScript served to browsers. Treat it as ' +
      'disclosed: rotate it, then find the client component that reads it.\n',
  );
}

const unexpectedNames = nameHits.filter(({ name }) => !NAME_ALLOWLIST.has(name));
if (unexpectedNames.length > 0) {
  failed = true;
  console.error('Server-only environment variable names found in the client bundle:\n');
  for (const { name, file } of unexpectedNames) console.error(`  ${name}  →  ${file}`);
  console.error(
    '\nA server-only value reached a client component. Move the read behind a server boundary, ' +
      'or expose an explicitly public NEXT_PUBLIC_* value instead.\n' +
      'If this is a third-party isomorphic env shim naming the variable without disclosing it, ' +
      'add it to NAME_ALLOWLIST in this file with the reason — the value scan still covers it.\n',
  );
}

if (failed) process.exit(1);

const allowlisted = [...new Set(nameHits.map(({ name }) => name))].filter((name) =>
  NAME_ALLOWLIST.has(name),
);

console.log(
  `Client bundle clean — ${String(names.length)} server-only names checked, ` +
    `${String(secrets.length)} values verified absent.`,
);
for (const name of allowlisted) {
  console.log(`  allowlisted mention: ${name} — ${NAME_ALLOWLIST.get(name) ?? ''}`);
}
