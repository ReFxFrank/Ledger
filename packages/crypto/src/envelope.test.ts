import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LedgerError } from '@ledger/core';
import {
  Keyring,
  type KeyMaterial,
  type SealedValue,
  aadFor,
  keyFromBase64,
  keyIdFor,
  open,
  reseal,
  safeEqual,
  seal,
} from './envelope';

function makeKey(): KeyMaterial {
  const key = randomBytes(32);
  return { keyId: keyIdFor(key), key };
}

const AAD = aadFor('bank_connections', 'row-1', 'access_token');
const TOKEN = 'access-sandbox-a1b2c3d4-e5f6-7890-abcd-ef1234567890';

describe('seal / open', () => {
  it('round-trips a value', () => {
    const keyring = new Keyring(makeKey());
    const sealed = seal(keyring, TOKEN, AAD);
    expect(open(keyring, sealed, AAD)).toBe(TOKEN);
  });

  it('never leaves the plaintext visible in the envelope', () => {
    const keyring = new Keyring(makeKey());
    const sealed = seal(keyring, TOKEN, AAD);

    // The whole point of a pg_dump being safe: the token must not be recoverable by reading the
    // column, in base64 or in raw bytes.
    expect(sealed.ciphertext).not.toContain(TOKEN);
    expect(Buffer.from(sealed.ciphertext, 'base64').toString('binary')).not.toContain(TOKEN);
    expect(Buffer.from(sealed.ciphertext, 'base64').toString('utf8')).not.toContain('access-sandbox');
  });

  it('produces a different envelope every time, so identical secrets are not correlatable', () => {
    const keyring = new Keyring(makeKey());
    const a = seal(keyring, TOKEN, AAD);
    const b = seal(keyring, TOKEN, AAD);

    // Two users with the same token must not have matching ciphertext — a fresh DEK and a fresh
    // nonce per seal is what stops the column being a lookup table.
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(open(keyring, a, AAD)).toBe(open(keyring, b, AAD));
  });

  it('handles an empty string and a large value', () => {
    const keyring = new Keyring(makeKey());
    expect(open(keyring, seal(keyring, '', AAD), AAD)).toBe('');

    const large = 'x'.repeat(100_000);
    expect(open(keyring, seal(keyring, large, AAD), AAD)).toBe(large);
  });

  it('preserves non-ASCII exactly', () => {
    const keyring = new Keyring(makeKey());
    const value = 'naïve — 日本語 — 🔑';
    expect(open(keyring, seal(keyring, value, AAD), AAD)).toBe(value);
  });

  it('records which key sealed it', () => {
    const key = makeKey();
    const sealed = seal(new Keyring(key), TOKEN, AAD);
    expect(sealed.keyId).toBe(key.keyId);
  });
});

describe('AAD binding', () => {
  /**
   * The attack this defends against: someone with write access to the database copies another
   * user's `access_token_ciphertext` into their own connection row. Without AAD it would decrypt
   * cleanly and hand them a working bank token.
   */
  it('refuses ciphertext moved to a different row', () => {
    const keyring = new Keyring(makeKey());
    const sealed = seal(keyring, TOKEN, aadFor('bank_connections', 'victim-row', 'access_token'));

    expect(() =>
      open(keyring, sealed, aadFor('bank_connections', 'attacker-row', 'access_token')),
    ).toThrow(LedgerError);
  });

  it('refuses ciphertext moved to a different column', () => {
    const keyring = new Keyring(makeKey());
    const sealed = seal(keyring, TOKEN, aadFor('bank_connections', 'row-1', 'access_token'));

    expect(() => open(keyring, sealed, aadFor('bank_connections', 'row-1', 'refresh_token'))).toThrow(
      LedgerError,
    );
  });

  it('refuses ciphertext moved to a different table', () => {
    const keyring = new Keyring(makeKey());
    const sealed = seal(keyring, TOKEN, aadFor('bank_connections', 'row-1', 'access_token'));

    expect(() => open(keyring, sealed, aadFor('account', 'row-1', 'access_token'))).toThrow(LedgerError);
  });

  it('builds a distinct AAD per address', () => {
    expect(aadFor('a', 'b', 'c').toString()).not.toBe(aadFor('a', 'b', 'd').toString());
    expect(aadFor('a', 'b', 'c').toString()).toBe(aadFor('a', 'b', 'c').toString());
  });
});

describe('tampering and wrong keys', () => {
  it('refuses to open under a key that did not seal it', () => {
    const sealed = seal(new Keyring(makeKey()), TOKEN, AAD);
    const other = makeKey();

    // A keyring that does not know the sealing key id fails at lookup rather than at decryption.
    expect(() => open(new Keyring(other), sealed, AAD)).toThrow(LedgerError);
  });

  it('refuses a key whose id matches but whose bytes do not', () => {
    const original = makeKey();
    const sealed = seal(new Keyring(original), TOKEN, AAD);

    // Same declared id, different material — the unwrap must fail rather than produce garbage.
    const impostor: KeyMaterial = { keyId: original.keyId, key: randomBytes(32) };
    expect(() => open(new Keyring(impostor), sealed, AAD)).toThrow(/unwrap/i);
  });

  it('refuses a flipped bit in the payload', () => {
    const keyring = new Keyring(makeKey());
    const sealed = seal(keyring, TOKEN, AAD);

    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0x01;

    expect(() => open(keyring, { ...sealed, ciphertext: bytes.toString('base64') }, AAD)).toThrow(
      /authentication/i,
    );
  });

  it('refuses a flipped bit in the wrapped data key', () => {
    const keyring = new Keyring(makeKey());
    const sealed = seal(keyring, TOKEN, AAD);

    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    // Offset 20 lands inside the wrapped DEK (1 version + 12 IV, then 32 key bytes).
    bytes[20] = (bytes[20] ?? 0) ^ 0x01;

    expect(() => open(keyring, { ...sealed, ciphertext: bytes.toString('base64') }, AAD)).toThrow(
      /unwrap/i,
    );
  });

  it('refuses a truncated envelope', () => {
    const keyring = new Keyring(makeKey());
    expect(() => open(keyring, { keyId: keyring.primaryKeyId, ciphertext: 'AAAA' }, AAD)).toThrow(
      /truncated|envelope/i,
    );
  });

  it('refuses an unknown envelope version', () => {
    const keyring = new Keyring(makeKey());
    const sealed = seal(keyring, TOKEN, AAD);
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[0] = 99;

    expect(() => open(keyring, { ...sealed, ciphertext: bytes.toString('base64') }, AAD)).toThrow(
      /version/i,
    );
  });

  it('names the missing key id without leaking key material', () => {
    const sealed = seal(new Keyring(makeKey()), TOKEN, AAD);
    const keyring = new Keyring(makeKey());

    try {
      open(keyring, sealed, AAD);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      const message = (error as LedgerError).message;
      expect(message).toContain(sealed.keyId);
      // The error is logged; it must not carry the secret it failed to open.
      expect(message).not.toContain(TOKEN);
      expect(JSON.stringify((error as LedgerError).meta)).not.toContain(TOKEN);
    }
  });
});

describe('key rotation', () => {
  /**
   * The rotation the runbook describes: the new key seals, the old key is retained so
   * not-yet-rotated rows still open, and `reseal` walks the table. Nothing goes offline.
   */
  it('opens records sealed under a retired key while sealing new ones under the primary', () => {
    const oldKey = makeKey();
    const newKey = makeKey();

    const before = seal(new Keyring(oldKey), TOKEN, AAD);

    const rotating = new Keyring(newKey, [oldKey]);
    expect(open(rotating, before, AAD)).toBe(TOKEN);

    const after = seal(rotating, TOKEN, AAD);
    expect(after.keyId).toBe(newKey.keyId);
  });

  it('re-seals an old record under the primary key, preserving the value', () => {
    const oldKey = makeKey();
    const newKey = makeKey();

    const before = seal(new Keyring(oldKey), TOKEN, AAD);
    const rotating = new Keyring(newKey, [oldKey]);

    const after = reseal(rotating, before, AAD);
    expect(after).not.toBeNull();
    expect((after as SealedValue).keyId).toBe(newKey.keyId);
    expect(open(rotating, after as SealedValue, AAD)).toBe(TOKEN);
  });

  it('skips a record already under the primary key, so a rotation is resumable', () => {
    const keyring = new Keyring(makeKey());
    const sealed = seal(keyring, TOKEN, AAD);

    // Returning null rather than re-sealing is what lets `keys:rotate` be re-run after an
    // interruption without redoing work.
    expect(reseal(keyring, sealed, AAD)).toBeNull();
  });

  it('cannot open a record once its key is dropped from the ring', () => {
    const oldKey = makeKey();
    const newKey = makeKey();
    const before = seal(new Keyring(oldKey), TOKEN, AAD);

    // Removing the retired key before the rotation finished — the runbook's warned-about mistake.
    expect(() => open(new Keyring(newKey), before, AAD)).toThrow(LedgerError);
  });

  it('lists the ids it can open', () => {
    const a = makeKey();
    const b = makeKey();
    const keyring = new Keyring(a, [b]);

    expect(keyring.knownKeyIds()).toContain(a.keyId);
    expect(keyring.knownKeyIds()).toContain(b.keyId);
    expect(keyring.primaryKeyId).toBe(a.keyId);
    expect(keyring.sealingKey().keyId).toBe(a.keyId);
  });
});

describe('keyFromBase64', () => {
  it('accepts exactly 32 bytes', () => {
    const raw = randomBytes(32).toString('base64');
    expect(keyFromBase64(raw).key).toHaveLength(32);
  });

  it('tolerates surrounding whitespace, which a copied env value usually has', () => {
    const raw = randomBytes(32).toString('base64');
    expect(keyFromBase64(`  ${raw}\n`).keyId).toBe(keyFromBase64(raw).keyId);
  });

  it('rejects a key of the wrong length and says how to make one', () => {
    expect(() => keyFromBase64(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => keyFromBase64(randomBytes(16).toString('base64'))).toThrow(/openssl rand/);
  });

  it('rejects an empty value', () => {
    expect(() => keyFromBase64('')).toThrow(LedgerError);
  });
});

describe('keyIdFor', () => {
  it('is stable across calls, so it survives a restart', () => {
    const key = randomBytes(32);
    expect(keyIdFor(key)).toBe(keyIdFor(key));
  });

  it('differs between keys', () => {
    expect(keyIdFor(randomBytes(32))).not.toBe(keyIdFor(randomBytes(32)));
  });

  it('does not reveal the key', () => {
    const key = randomBytes(32);
    const id = keyIdFor(key);
    expect(id).toHaveLength(16);
    expect(key.toString('hex')).not.toContain(id);
  });
});

describe('safeEqual', () => {
  it('compares equal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('rejects different strings of the same length', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'a')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(safeEqual('', '')).toBe(true);
  });
});
