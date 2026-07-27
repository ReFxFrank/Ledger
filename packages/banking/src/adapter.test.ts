/**
 * The adapter contract.
 *
 * Mostly one test: the sign convention. It is asserted here rather than assumed because a sign
 * flip is the failure mode of this package that produces no error, no log line, and no crash —
 * only a product that finds no subscriptions and looks like it is working.
 */

import { describe, expect, it } from 'vitest';
import { open, seal, Keyring, keyFromBase64 } from '@ledger/crypto';

import {
  AggregatorError,
  LEDGER_SIGN_CONVENTION,
  accessTokenAad,
  isRetryable,
  minorUnitsFromDecimal,
  toOutflowMinor,
} from './adapter';

function testKeyring(): Keyring {
  return new Keyring(keyFromBase64(Buffer.alloc(32, 7).toString('base64')));
}

describe('the sign convention', () => {
  it('is positive-for-outflow', () => {
    expect(LEDGER_SIGN_CONVENTION).toBe('positive-outflow');
  });

  it('leaves a positive-outflow aggregator (Plaid) untouched', () => {
    // A $17.99 Netflix charge as Plaid reports it.
    expect(toOutflowMinor(1799, 'positive-outflow')).toBe(1799);
    // A refund, as Plaid reports it.
    expect(toOutflowMinor(-1799, 'positive-outflow')).toBe(-1799);
  });

  it('flips a negative-outflow aggregator (Open Banking)', () => {
    // The same charge as a PSD2 API reports it: a debit is negative.
    expect(toOutflowMinor(-1799, 'negative-outflow')).toBe(1799);
    expect(toOutflowMinor(1799, 'negative-outflow')).toBe(-1799);
  });

  it('never produces -0, which JSON would round-trip into a different value', () => {
    expect(Object.is(toOutflowMinor(0, 'negative-outflow'), 0)).toBe(true);
  });

  it('refuses a non-integer amount rather than silently truncating money', () => {
    expect(() => toOutflowMinor(17.99, 'positive-outflow')).toThrow(/integer minor units/);
  });

  it('round-trips: a charge stays a charge, a refund stays a refund', () => {
    for (const convention of ['positive-outflow', 'negative-outflow'] as const) {
      const upstreamCharge = convention === 'positive-outflow' ? 1099 : -1099;
      const upstreamRefund = convention === 'positive-outflow' ? -1099 : 1099;
      expect(toOutflowMinor(upstreamCharge, convention)).toBeGreaterThan(0);
      expect(toOutflowMinor(upstreamRefund, convention)).toBeLessThan(0);
    }
  });
});

describe('minorUnitsFromDecimal', () => {
  it('quantises at the currency exponent', () => {
    expect(minorUnitsFromDecimal(17.99, 'USD')).toBe(1799);
    expect(minorUnitsFromDecimal(10.5, 'EUR')).toBe(1050);
  });

  it('honours currencies without a minor unit', () => {
    expect(minorUnitsFromDecimal(1200, 'JPY')).toBe(1200);
  });

  it('honours three-digit minor units', () => {
    expect(minorUnitsFromDecimal(1.234, 'KWD')).toBe(1234);
  });

  it('survives the amounts that break naive float maths', () => {
    // `19.99 * 100` is 1998.9999999999998 as a double, and `Math.round` of `0.29 * 100` is the
    // classic off-by-one. Quantising through the decimal string avoids both.
    expect(minorUnitsFromDecimal(19.99, 'USD')).toBe(1999);
    expect(minorUnitsFromDecimal(0.29, 'USD')).toBe(29);
    expect(minorUnitsFromDecimal(1234.56, 'USD')).toBe(123_456);
  });

  it('cannot recover precision the aggregator already lost', () => {
    // The nearest double to 1.005 is 1.00499999999999989…, so it rounds down. Nothing at this
    // boundary can fix that — the information was gone before the JSON was parsed. It is
    // asserted rather than ignored because the alternative is discovering it as a one-cent
    // discrepancy in someone's annual total, and because it is the argument for integer minor
    // units everywhere above this line.
    expect(minorUnitsFromDecimal(1.005, 'USD')).toBe(100);
  });

  it('keeps the sign', () => {
    expect(minorUnitsFromDecimal(-17.99, 'USD')).toBe(-1799);
    expect(Object.is(minorUnitsFromDecimal(-0.001, 'USD'), 0)).toBe(true);
  });

  it('falls back to two digits for a junk currency code rather than dropping the row', () => {
    expect(minorUnitsFromDecimal(5.5, 'ZZZ')).toBe(550);
  });
});

describe('accessTokenAad', () => {
  it('binds a sealed token to its provider and item', () => {
    const keyring = testKeyring();
    const sealed = seal(keyring, 'access-sandbox-abc', accessTokenAad('plaid', 'item-1'));

    expect(open(keyring, sealed, accessTokenAad('plaid', 'item-1'))).toBe('access-sandbox-abc');
    // Lifted into another connection's row, it fails authentication instead of decrypting.
    expect(() => open(keyring, sealed, accessTokenAad('plaid', 'item-2'))).toThrow();
    expect(() => open(keyring, sealed, accessTokenAad('fixture', 'item-1'))).toThrow();
  });
});

describe('AggregatorError', () => {
  it('classifies retryability so the UI does not ask a user to fix a bank outage', () => {
    expect(isRetryable('temporarily_unavailable')).toBe(true);
    expect(isRetryable('rate_limited')).toBe(true);
    expect(isRetryable('reauth_required')).toBe(false);
  });

  it('carries no cause, so a logger walking the chain cannot reach an upstream request', () => {
    const error = new AggregatorError('plaid', 'upstream', 'Something went wrong.');
    expect(error.cause).toBeUndefined();
    expect(error.meta.provider).toBe('plaid');
  });
});
