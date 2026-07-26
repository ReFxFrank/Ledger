/**
 * Envelope encryption for data at rest (brief §9.1).
 *
 * Each secret gets its own 256-bit data key (DEK). The DEK encrypts the plaintext with
 * AES-256-GCM; the KEK — from `ENCRYPTION_KEY` or KMS — encrypts the DEK. Both the wrapped DEK
 * and the ciphertext live in the same column, so a `pg_dump` yields one opaque blob per secret.
 *
 * Why per-record DEKs rather than encrypting directly under the KEK:
 *
 *  - Rotation becomes cheap and interruptible. Rotating re-wraps DEKs; it never re-encrypts
 *    payloads, so `pnpm keys:rotate` is a small, resumable, online operation.
 *  - A single leaked DEK compromises exactly one record.
 *  - Nonce reuse under one long-lived key is the classic way to break GCM. A fresh key per
 *    record makes the (random, 96-bit) nonce space per key effectively unlimited.
 *
 * Every seal is bound to an AAD naming the table, row, and column. Ciphertext lifted from one
 * row and pasted into another fails authentication instead of silently decrypting.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { LedgerError } from '@ledger/core';

const VERSION = 1;
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit nonce, the GCM-recommended size
const TAG_BYTES = 16;

/** version | dekIv | wrappedDek | dekTag | iv | tag | ciphertext */
const HEADER_BYTES = 1 + IV_BYTES + KEY_BYTES + TAG_BYTES + IV_BYTES + TAG_BYTES;

export interface SealedValue {
  /** Which KEK sealed this. Lets old and new keys coexist mid-rotation. */
  readonly keyId: string;
  /** Base64 envelope: wrapped DEK plus ciphertext plus both auth tags. */
  readonly ciphertext: string;
}

export interface KeyMaterial {
  readonly keyId: string;
  readonly key: Buffer;
}

/**
 * A keyring holds the key that seals and every key that can still open.
 *
 * During a rotation both are present, so the app keeps serving reads of not-yet-rotated rows
 * while the rotation walks the table. That is the whole reason `keys:rotate` needs no downtime.
 */
export class Keyring {
  private readonly primary: KeyMaterial;
  private readonly byId: Map<string, KeyMaterial>;

  constructor(primary: KeyMaterial, additional: readonly KeyMaterial[] = []) {
    this.primary = primary;
    this.byId = new Map([primary, ...additional].map((k) => [k.keyId, k]));
  }

  get primaryKeyId(): string {
    return this.primary.keyId;
  }

  sealingKey(): KeyMaterial {
    return this.primary;
  }

  openingKey(keyId: string): KeyMaterial {
    const key = this.byId.get(keyId);
    if (key === undefined) {
      throw new LedgerError(
        'ENCRYPTION_ERROR',
        `No key available for key id ${keyId}. If a KEK was rotated out, the old one is still ` +
          'required until `pnpm keys:rotate` has finished.',
        { meta: { keyId, available: [...this.byId.keys()] } },
      );
    }
    return key;
  }

  knownKeyIds(): string[] {
    return [...this.byId.keys()];
  }
}

/**
 * Derives a stable, non-secret identifier for a key.
 *
 * A truncated SHA-256 of the key bytes: it never reverses to the key, and it survives restarts
 * and redeploys, which a random id assigned at boot would not.
 */
export function keyIdFor(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function keyFromBase64(encoded: string): KeyMaterial {
  const key = Buffer.from(encoded.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new LedgerError(
      'CONFIGURATION_ERROR',
      `Encryption key must decode to exactly ${String(KEY_BYTES)} bytes, got ${String(key.length)}. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
  return { keyId: keyIdFor(key), key };
}

/**
 * Additional authenticated data: the address of the secret.
 *
 * Binding the ciphertext to its location means an attacker with write access to the database
 * still cannot move a valid access token from one user's connection row to their own.
 */
export function aadFor(table: string, rowId: string, column: string): Buffer {
  return Buffer.from(`ledger:v${String(VERSION)}:${table}:${rowId}:${column}`, 'utf8');
}

export function seal(keyring: Keyring, plaintext: string, aad: Buffer): SealedValue {
  const { keyId, key: kek } = keyring.sealingKey();

  const dek = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const dekIv = randomBytes(IV_BYTES);
  const wrapper = createCipheriv('aes-256-gcm', kek, dekIv);
  wrapper.setAAD(aad);
  const wrappedDek = Buffer.concat([wrapper.update(dek), wrapper.final()]);
  const dekTag = wrapper.getAuthTag();

  // Zero the DEK once it is wrapped. Node may still hold copies, but leaving it live in a
  // long-running worker's heap for the GC to eventually reclaim is a needless window.
  dek.fill(0);

  const envelope = Buffer.concat([
    Buffer.from([VERSION]),
    dekIv,
    wrappedDek,
    dekTag,
    iv,
    tag,
    body,
  ]);

  return { keyId, ciphertext: envelope.toString('base64') };
}

export function open(keyring: Keyring, sealed: SealedValue, aad: Buffer): string {
  const envelope = Buffer.from(sealed.ciphertext, 'base64');
  if (envelope.length < HEADER_BYTES) {
    throw new LedgerError('ENCRYPTION_ERROR', 'Sealed value is truncated or not an envelope.');
  }

  const version = envelope[0];
  if (version !== VERSION) {
    throw new LedgerError('ENCRYPTION_ERROR', `Unsupported envelope version ${String(version)}.`);
  }

  let offset = 1;
  const dekIv = envelope.subarray(offset, (offset += IV_BYTES));
  const wrappedDek = envelope.subarray(offset, (offset += KEY_BYTES));
  const dekTag = envelope.subarray(offset, (offset += TAG_BYTES));
  const iv = envelope.subarray(offset, (offset += IV_BYTES));
  const tag = envelope.subarray(offset, (offset += TAG_BYTES));
  const body = envelope.subarray(offset);

  const { key: kek } = keyring.openingKey(sealed.keyId);

  let dek: Buffer;
  try {
    const unwrapper = createDecipheriv('aes-256-gcm', kek, dekIv);
    unwrapper.setAAD(aad);
    unwrapper.setAuthTag(dekTag);
    dek = Buffer.concat([unwrapper.update(wrappedDek), unwrapper.final()]);
  } catch (cause) {
    throw new LedgerError(
      'ENCRYPTION_ERROR',
      'Could not unwrap the data key. The KEK is wrong, or the record was moved between rows.',
      { cause, meta: { keyId: sealed.keyId } },
    );
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch (cause) {
    throw new LedgerError('ENCRYPTION_ERROR', 'Sealed value failed authentication.', { cause });
  } finally {
    dek.fill(0);
  }
}

/**
 * Re-seals under the current primary key. Used by `pnpm keys:rotate`.
 *
 * Returns null when the record is already under the primary key, so a rotation can skip rows it
 * has already done and resume cleanly after an interruption.
 */
export function reseal(keyring: Keyring, sealed: SealedValue, aad: Buffer): SealedValue | null {
  if (sealed.keyId === keyring.primaryKeyId) return null;
  return seal(keyring, open(keyring, sealed, aad), aad);
}

/** Constant-time comparison, for anything a caller might otherwise `===`. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
