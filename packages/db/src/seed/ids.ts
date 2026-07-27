/**
 * Stable identifiers for the demo dataset.
 *
 * The seed has to be idempotent — running it twice must not produce forty subscriptions — and
 * every table it writes to has a random-by-default primary key. So the ids are *derived* from a
 * name rather than generated: the same name always produces the same UUID, which turns every
 * insert into an `ON CONFLICT (id) DO UPDATE` and makes a re-run a no-op instead of a duplicate.
 *
 * `uuidv7()` from @ledger/core is deliberately not used here. It is time-sortable, which is the
 * right property for real rows and exactly the wrong one for a fixture that must be reproducible.
 */

import { createHash } from 'node:crypto';

/**
 * Namespaced so a demo id can never collide with a real one, and versioned so a future change
 * to the dataset shape can re-key everything at once instead of half-updating live rows.
 */
const NAMESPACE = 'ledger.seed.demo.v1';

const HEX = '0123456789abcdef';

/**
 * A deterministic UUID for `name`.
 *
 * Version nibble 8 (RFC 9562 "custom") rather than 4, because these are not random and labelling
 * them as if they were would mislead anyone reading a row in psql.
 */
export function demoUuid(name: string): string {
  const digest = createHash('sha256').update(`${NAMESPACE}:${name}`).digest();
  const bytes = new Uint8Array(digest.subarray(0, 16));

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  let out = '';
  for (let index = 0; index < 16; index += 1) {
    if (index === 4 || index === 6 || index === 8 || index === 10) out += '-';
    const byte = bytes[index] ?? 0;
    out += (HEX[byte >> 4] ?? '0') + (HEX[byte & 0x0f] ?? '0');
  }
  return out;
}

/**
 * The demo user's id.
 *
 * `user.id` is `text` because better-auth owns that column, so this is readable on purpose —
 * anyone poking at the database should be able to tell demo rows from real ones at a glance.
 */
export const DEMO_USER_ID = 'demo-user-ledger';
