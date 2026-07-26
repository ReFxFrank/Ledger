/**
 * Identifiers.
 *
 * UUIDv7: a 48-bit millisecond timestamp followed by random bits, so ids sort by creation time.
 * That matters here because `transactions` is the table that gets large, and a v4 primary key
 * scatters inserts across the whole B-tree. v7 keeps them at the right-hand edge.
 *
 * Uses the `crypto` global rather than `node:crypto` — this package has to stay importable from
 * `packages/detection`, which is not allowed a single node builtin.
 */

import { InvalidArgumentError } from './errors';

const HEX = '0123456789abcdef';

let lastMillis = -1;
let sequence = 0;

/** A time-sortable UUIDv7. Monotonic within a millisecond. */
export function uuidv7(nowMillis: number = Date.now()): string {
  if (nowMillis === lastMillis) {
    sequence += 1;
  } else {
    lastMillis = nowMillis;
    sequence = 0;
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);

  // 48-bit big-endian timestamp
  const millis = BigInt(nowMillis);
  bytes[0] = Number((millis >> 40n) & 0xffn);
  bytes[1] = Number((millis >> 32n) & 0xffn);
  bytes[2] = Number((millis >> 24n) & 0xffn);
  bytes[3] = Number((millis >> 16n) & 0xffn);
  bytes[4] = Number((millis >> 8n) & 0xffn);
  bytes[5] = Number(millis & 0xffn);

  // 12-bit monotonic counter in rand_a, so ids minted in the same millisecond still order.
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;

  // RFC 4122 variant bits
  const nine = bytes[8] ?? 0;
  bytes[8] = (nine & 0x3f) | 0x80;

  return formatUuid(bytes);
}

function formatUuid(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    const byte = bytes[i] ?? 0;
    out += (HEX[byte >> 4] ?? '0') + (HEX[byte & 0x0f] ?? '0');
  }
  return out;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function assertUuid(value: string, label = 'id'): string {
  if (!isUuid(value)) throw new InvalidArgumentError(`${label} is not a UUID: ${JSON.stringify(value)}`);
  return value.toLowerCase();
}

/**
 * A URL-safe random token. Used for share links and one-time flows — never for anything that
 * needs to be a secret at rest, which goes through @ledger/crypto instead.
 */
export function randomToken(byteLength = 24): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A stable, order-insensitive key for deduping.
 *
 * `notifications.dedupe_key` is UNIQUE precisely so a user is never told the same thing twice
 * (brief §8); building that key by string concatenation at each call site is how you end up with
 * `trial:abc:2026-01-01` in one place and `trial-abc-2026-01-01` in another, and two emails.
 */
export function dedupeKey(...parts: readonly (string | number | null | undefined)[]): string {
  return parts
    .filter((part): part is string | number => part !== null && part !== undefined && part !== '')
    .map((part) => String(part).trim().toLowerCase().replace(/\s+/g, '-'))
    .join(':');
}
