import { createHmac } from 'node:crypto';

/**
 * RFC 6238 TOTP, for the end-to-end tests.
 *
 * 2FA is mandatory, so every e2e spec has to get past an authenticator prompt. Adding a library
 * for thirty lines of HMAC would be the wrong trade — and a hand-written implementation here is
 * verifiable in a way a dependency is not: the unit test alongside this file runs the RFC's own
 * published vectors, so if this is wrong, it is wrong loudly and immediately rather than as a
 * mysterious "invalid code" in a browser three layers away.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decodes an RFC 4648 base32 secret, the format authenticator apps are provisioned with. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');

  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Not a base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

export interface TotpOptions {
  readonly digits?: number;
  readonly period?: number;
  readonly algorithm?: 'sha1' | 'sha256' | 'sha512';
  /** Unix seconds. Explicit so a test can generate a code for a specific moment. */
  readonly forTime?: number;
}

export function generateTotp(secret: string | Buffer, options: TotpOptions = {}): string {
  const { digits = 6, period = 30, algorithm = 'sha1', forTime } = options;
  const key = typeof secret === 'string' ? base32Decode(secret) : secret;

  const seconds = forTime ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(seconds / period);

  // 8-byte big-endian counter. Written via BigInt because a plain 32-bit shift silently wraps
  // past 2038, and a test suite that starts failing on a specific future date is a bad legacy.
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(algorithm, key).update(buffer).digest();

  // Dynamic truncation, RFC 4226 §5.4.
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Seconds until the current code expires.
 *
 * A test that types a code with 400ms left on it fails intermittently and looks like a flaky
 * app. Specs wait on this instead.
 */
export function secondsUntilRollover(period = 30, forTime?: number): number {
  const seconds = forTime ?? Math.floor(Date.now() / 1000);
  return period - (seconds % period);
}

/** Pulls the base32 secret out of an `otpauth://` provisioning URI. */
export function secretFromOtpauthUri(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret');
  if (secret === null) throw new Error(`No secret in provisioning URI: ${uri}`);
  return secret;
}
