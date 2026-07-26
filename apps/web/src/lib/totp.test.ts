import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  generateTotp,
  secondsUntilRollover,
  secretFromOtpauthUri,
} from '../../e2e/support/totp';

/**
 * RFC 6238 Appendix B test vectors.
 *
 * The e2e suite cannot get past the mandatory 2FA prompt without a working TOTP generator, and a
 * generator that is subtly wrong surfaces as "invalid code" in a browser three layers from the
 * bug. These vectors are the published ground truth, so a break here is unambiguous.
 *
 * The RFC's seed is the ASCII string "12345678901234567890", used as raw key bytes rather than
 * base32 — hence the Buffer overload.
 */
const RFC_SEED = Buffer.from('12345678901234567890', 'ascii');

describe('generateTotp — RFC 6238 vectors', () => {
  const vectors: readonly { time: number; expected: string }[] = [
    { time: 59, expected: '287082' },
    { time: 1_111_111_109, expected: '081804' },
    { time: 1_111_111_111, expected: '050471' },
    { time: 1_234_567_890, expected: '005924' },
    { time: 2_000_000_000, expected: '279037' },
    { time: 20_000_000_000, expected: '353130' },
  ];

  for (const { time, expected } of vectors) {
    it(`matches the published 6-digit SHA-1 code at t=${String(time)}`, () => {
      expect(generateTotp(RFC_SEED, { forTime: time, digits: 6, algorithm: 'sha1' })).toBe(expected);
    });
  }

  // t=20000000000 is past 2038. A 32-bit counter would have wrapped, and the suite would have
  // started failing on a specific future date for reasons nobody would connect to this file.
  it('still works past the 32-bit epoch rollover', () => {
    expect(generateTotp(RFC_SEED, { forTime: 20_000_000_000 })).toBe('353130');
  });

  // Windows are aligned to the epoch, not to the timestamp asked about: t=1000 falls in the
  // bucket 990–1019, so 1029 is already the *next* code. Getting this boundary wrong is exactly
  // why `secondsUntilRollover` exists for the specs to wait on.
  it('produces a stable code within a period and a different one after it', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(generateTotp(secret, { forTime: 990 })).toBe(generateTotp(secret, { forTime: 1019 }));
    expect(generateTotp(secret, { forTime: 990 })).not.toBe(generateTotp(secret, { forTime: 1020 }));
  });

  it('pads a short code to the requested digit count', () => {
    // The t=1234567890 vector is 005924 — the leading zeros are the point.
    expect(generateTotp(RFC_SEED, { forTime: 1_234_567_890 })).toHaveLength(6);
    expect(generateTotp(RFC_SEED, { forTime: 1_234_567_890 })).toBe('005924');
  });
});

describe('base32Decode', () => {
  // Asserted as hex, not as a decoded string: the trailing bytes are 0xDEADBEEF, which is not
  // valid UTF-8, so a string comparison here tests the replacement-character behaviour of
  // Buffer.toString rather than the decoder.
  it('decodes an authenticator-style secret to the right bytes', () => {
    expect(base32Decode('JBSWY3DPEHPK3PXP').toString('hex')).toBe('48656c6c6f21deadbeef');
  });

  it('tolerates padding, whitespace, and lowercase', () => {
    const canonical = base32Decode('JBSWY3DP');
    expect(base32Decode('jbswy3dp')).toEqual(canonical);
    expect(base32Decode('JBSW Y3DP')).toEqual(canonical);
    expect(base32Decode('JBSWY3DP====')).toEqual(canonical);
  });

  it('rejects a character outside the alphabet', () => {
    expect(() => base32Decode('JBSW1DP')).toThrow(/base32/);
  });
});

describe('secondsUntilRollover', () => {
  it('reports the time left in the current window', () => {
    expect(secondsUntilRollover(30, 1000)).toBe(20);
    expect(secondsUntilRollover(30, 1020)).toBe(30);
    expect(secondsUntilRollover(30, 1029)).toBe(21);
  });
});

describe('secretFromOtpauthUri', () => {
  it('extracts the secret from a provisioning URI', () => {
    expect(
      secretFromOtpauthUri('otpauth://totp/Ledger:a@b.com?secret=JBSWY3DPEHPK3PXP&issuer=Ledger'),
    ).toBe('JBSWY3DPEHPK3PXP');
  });

  it('throws when the URI carries no secret', () => {
    expect(() => secretFromOtpauthUri('otpauth://totp/Ledger:a@b.com?issuer=Ledger')).toThrow(
      /No secret/,
    );
  });
});
