import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keyring, type KeyMaterial, aadFor, keyIdFor, open, seal } from './envelope';
import { type ResealDecision, createTally, decideReseal, recordDecision } from './rotation';

function makeKey(): KeyMaterial {
  const key = randomBytes(32);
  return { keyId: keyIdFor(key), key };
}

const AAD = aadFor('bank_connections', 'plaid:item-1', 'access_token_ciphertext');
const TOKEN = 'access-sandbox-a1b2c3d4-e5f6-7890-abcd-ef1234567890';

describe('decideReseal', () => {
  it('rotates a row sealed under a retired key, preserving the value', () => {
    const oldKey = makeKey();
    const newKey = makeKey();
    const before = seal(new Keyring(oldKey), TOKEN, AAD);

    const rotating = new Keyring(newKey, [oldKey]);
    const decision = decideReseal(rotating, {
      id: 'row-1',
      keyId: before.keyId,
      ciphertext: before.ciphertext,
      aad: AAD,
    });

    expect(decision.kind).toBe('rotate');
    if (decision.kind !== 'rotate') return;
    expect(decision.fromKeyId).toBe(oldKey.keyId);
    expect(decision.sealed.keyId).toBe(newKey.keyId);
    expect(open(rotating, decision.sealed, AAD)).toBe(TOKEN);
  });

  it('skips a row already under the primary key — the resumability mechanism', () => {
    const keyring = new Keyring(makeKey());
    const sealed = seal(keyring, TOKEN, AAD);

    const decision = decideReseal(keyring, {
      id: 'row-1',
      keyId: sealed.keyId,
      ciphertext: sealed.ciphertext,
      aad: AAD,
    });

    expect(decision).toEqual({ kind: 'current', id: 'row-1' });
  });

  it('reports a row whose key is missing from the ring instead of throwing', () => {
    const strandedKey = makeKey();
    const sealed = seal(new Keyring(strandedKey), TOKEN, AAD);

    // The ring that will do the rotating never had strandedKey — the runbook's warned-about
    // state where a retired key was removed too early.
    const keyring = new Keyring(makeKey());
    const decision = decideReseal(keyring, {
      id: 'row-1',
      keyId: sealed.keyId,
      ciphertext: sealed.ciphertext,
      aad: AAD,
    });

    expect(decision.kind).toBe('unopenable');
    if (decision.kind !== 'unopenable') return;
    expect(decision.id).toBe('row-1');
    expect(decision.keyId).toBe(strandedKey.keyId);
    expect(decision.reason).toContain(strandedKey.keyId);
    // The report gets logged; the secret must not ride along in it.
    expect(decision.reason).not.toContain(TOKEN);
  });

  it('reports a row whose AAD does not match instead of throwing', () => {
    const oldKey = makeKey();
    const sealed = seal(new Keyring(oldKey), TOKEN, AAD);
    const keyring = new Keyring(makeKey(), [oldKey]);

    const decision = decideReseal(keyring, {
      id: 'row-1',
      keyId: sealed.keyId,
      ciphertext: sealed.ciphertext,
      // The address the ciphertext was NOT sealed against — a moved or corrupted row.
      aad: aadFor('bank_connections', 'plaid:item-2', 'access_token_ciphertext'),
    });

    expect(decision.kind).toBe('unopenable');
  });

  it('classifies a dry run exactly as the wet run would', () => {
    const oldKey = makeKey();
    const newKey = makeKey();
    const strandedKey = makeKey();
    const keyring = new Keyring(newKey, [oldKey]);

    const rows = [
      { id: 'stale', ...seal(new Keyring(oldKey), TOKEN, AAD) },
      { id: 'fresh', ...seal(keyring, TOKEN, AAD) },
      { id: 'stranded', ...seal(new Keyring(strandedKey), TOKEN, AAD) },
    ].map((row) => ({ ...row, aad: AAD }));

    // The sealed bytes differ between calls (fresh DEK and nonce each time), but the
    // classification — the part a dry run reports — must be identical.
    const dry = rows.map((row) => decideReseal(keyring, row));
    const wet = rows.map((row) => decideReseal(keyring, row));

    expect(dry.map((d) => ({ kind: d.kind, id: d.id }))).toEqual(
      wet.map((d) => ({ kind: d.kind, id: d.id })),
    );
    expect(dry.map((d) => d.kind)).toEqual(['rotate', 'current', 'unopenable']);
  });
});

describe('recordDecision', () => {
  it('tallies each decision kind into the report the runbook asks for', () => {
    const tally = createTally();
    const decisions: ResealDecision[] = [
      { kind: 'rotate', id: 'a', fromKeyId: 'old', sealed: { keyId: 'new', ciphertext: 'x' } },
      { kind: 'current', id: 'b' },
      { kind: 'current', id: 'c' },
      { kind: 'unopenable', id: 'd', keyId: 'gone', reason: 'No key available for key id gone' },
    ];
    for (const decision of decisions) recordDecision(tally, decision);

    expect(tally.total).toBe(4);
    expect(tally.rotated).toBe(1);
    expect(tally.alreadyCurrent).toBe(2);
    expect(tally.failures).toEqual([
      { id: 'd', keyId: 'gone', reason: 'No key available for key id gone' },
    ]);
  });
});
