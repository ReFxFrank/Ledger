#!/usr/bin/env node
/**
 * Brief §9.7 — "Add a CI check that greps the built client for known env var names."
 *
 * Reads every variable name out of .env.example, drops the ones that are legitimately
 * public (NEXT_PUBLIC_*) or structurally non-secret, and fails if any of the rest appears
 * as a literal string inside the client bundle Next emitted.
 *
 * This catches the classic mistake — a server-only value read from a module that gets
 * pulled into a client component through an innocent-looking re-export.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = join(root, 'apps', 'web', '.next', 'static');

/** Names that are public by construction or too generic to be meaningful signal. */
const ALLOWED = new Set(['NODE_ENV', 'LOG_LEVEL', 'PLAID_ENV', 'EMAIL_FROM']);

function envNames() {
  const raw = readFileSync(join(root, '.env.example'), 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim())
    .filter((name) => Boolean(name) && !name.startsWith('NEXT_PUBLIC_') && !ALLOWED.has(name));
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(js|mjs|json|txt)$/.test(entry)) yield full;
  }
}

if (!existsSync(clientDir)) {
  console.error(`No client bundle at ${clientDir}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const names = envNames();
const violations = [];

for (const file of walk(clientDir)) {
  const content = readFileSync(file, 'utf8');
  for (const name of names) {
    if (content.includes(name)) {
      violations.push({ file: file.slice(root.length + 1), name });
    }
  }
}

if (violations.length > 0) {
  console.error('Server-only environment variable names found in the client bundle:\n');
  for (const { file, name } of violations) console.error(`  ${name}  →  ${file}`);
  console.error(
    '\nA server-only value reached a client component. Move the read behind a server ' +
      'boundary, or expose an explicitly public NEXT_PUBLIC_* value instead.',
  );
  process.exit(1);
}

console.log(`Client bundle clean — checked ${String(names.length)} server-only variable names.`);
