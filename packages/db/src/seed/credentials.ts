/**
 * The demo user's sign-in credentials.
 *
 * 2FA is mandatory (brief §9.2), so a demo whose TOTP secret nobody knows is a demo nobody can
 * open. This module mints a real password hash and a real RFC-6238 secret, deterministically,
 * and `demo.ts` prints both.
 *
 * Two things worth being explicit about, because they look like violations and are not:
 *
 *  - **These are not a user's secrets.** They are a fixture minted locally for a throwaway
 *    account on a developer's machine, printed to that developer's terminal. @ledger/crypto
 *    seals *user* data at rest under a KEK; that is a different job and a different key.
 *  - **The salt is fixed.** A per-run salt would make the seed non-deterministic and the hash
 *    would change on every re-run. For a credential that is printed to stdout by design, the
 *    salt is not protecting anything.
 *
 * The password hash format is scrypt `salt:key`, both hex, with the parameters better-auth's
 * node implementation uses (`@better-auth/utils/password`). It is reproduced here rather than
 * imported because @ledger/db does not — and should not — depend on the auth library. If
 * sign-in ever starts rejecting the demo password, these four numbers are the first place to
 * look.
 */

import { createHash, scryptSync } from 'node:crypto';

const SCRYPT = { N: 16_384, r: 16, p: 1, dkLen: 64 } as const;

/** better-auth's `generateRandomString(32)` alphabet. The secret is used as a raw HMAC key. */
const SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** RFC 4648 base32, which is what an authenticator app expects in an `otpauth://` URI. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const BACKUP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface DemoCredentials {
  readonly email: string;
  readonly password: string;
  /** better-auth's `account.password` column: `saltHex:keyHex`. */
  readonly passwordHash: string;
  /** The raw TOTP secret, as better-auth stores it before encryption. */
  readonly totpSecret: string;
  /** The same secret base32-encoded — what you type into an authenticator app. */
  readonly totpSecretBase32: string;
  readonly totpUri: string;
  readonly backupCodes: readonly string[];
}

/**
 * Deterministic characters from `seed`, drawn uniformly from `alphabet`.
 *
 * Rejection sampling rather than a plain modulus: with a 62-character alphabet, `byte % 62`
 * over-represents the first eight characters by ~3%. That bias would not matter for a demo, but
 * this function also mints the TOTP secret, and a biased secret generator is the kind of thing
 * that gets copied into somewhere it does matter.
 */
function derive(seed: string, length: number, alphabet: string): string {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = '';
  let counter = 0;

  while (out.length < length) {
    const block = createHash('sha256').update(`${seed}#${String(counter)}`).digest();
    for (const byte of block) {
      if (out.length >= length) break;
      if (byte >= limit) continue;
      const character = alphabet[byte % alphabet.length];
      if (character !== undefined) out += character;
    }
    counter += 1;
  }
  return out;
}

/** Base32 of the secret's ASCII bytes, unpadded — the encoding `otpauth://` URIs use. */
export function base32Encode(input: string): string {
  const bytes = Buffer.from(input, 'utf8');
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f] ?? '';
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f] ?? '';
  return out;
}

export function hashPassword(password: string, saltHex: string): string {
  // NFKC first: better-auth normalises before hashing, and a password typed on a Mac and a
  // password typed on Windows can differ by nothing but composition form.
  const key = scryptSync(password.normalize('NFKC'), saltHex, SCRYPT.dkLen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    // node's default cap is 32 MB, which N=16384/r=16 exceeds. Same formula better-auth uses.
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
  return `${saltHex}:${key.toString('hex')}`;
}

export interface BuildCredentialsOptions {
  readonly email: string;
  readonly password: string;
  readonly issuer: string;
}

export function buildDemoCredentials(options: BuildCredentialsOptions): DemoCredentials {
  const saltHex = createHash('sha256')
    .update(`ledger.seed.demo.salt:${options.email}`)
    .digest('hex')
    .slice(0, 32);

  const totpSecret = derive(`totp:${options.email}`, 32, SECRET_ALPHABET);
  const totpSecretBase32 = base32Encode(totpSecret);

  const params = new URLSearchParams({
    secret: totpSecretBase32,
    issuer: options.issuer,
    digits: '6',
    period: '30',
  });
  const label = `${encodeURIComponent(options.issuer)}:${encodeURIComponent(options.email)}`;

  return {
    email: options.email,
    password: options.password,
    passwordHash: hashPassword(options.password, saltHex),
    totpSecret,
    totpSecretBase32,
    totpUri: `otpauth://totp/${label}?${params.toString()}`,
    backupCodes: Array.from({ length: 10 }, (_unused, index) => {
      const code = derive(`backup:${options.email}:${String(index)}`, 10, BACKUP_CODE_ALPHABET);
      return `${code.slice(0, 5)}-${code.slice(5)}`;
    }),
  };
}
