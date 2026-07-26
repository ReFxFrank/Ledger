/**
 * fx.ts and commitment.ts.
 *
 * Two classes of quiet wrongness are pinned down here, because both produce a number that looks
 * plausible on a dashboard:
 *
 *  1. **Exponent mismatch.** ¥1,000 is `amountMinor: 1000` at exponent 0; $10.00 is
 *     `amountMinor: 1000` at exponent 2. "amountMinor × rate" is therefore a factor-of-100 error
 *     in either direction. Every exponent combination (0→2, 2→0, 3→2, 2→3) has a hand-computed
 *     expected value below.
 *  2. **"4-weekly is basically monthly."** It is 365/28 ≈ 13.04 charges a year. £8.99 every four
 *     weeks annualises to £117.19, not £107.88.
 *
 * Every expected minor-unit figure is worked out by hand in the comment beside it. None of them
 * is a snapshot of whatever the implementation happened to return.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { currency } from './currency';
import { InvalidArgumentError, UnsupportedCurrencyError, isLedgerError } from './errors';
import {
  FX_SCALE,
  type FxRate,
  convert,
  fxRate,
  identityRate,
  invertRate,
  staticRateTable,
  sumConverted,
} from './fx';
import { ANNUAL, FOUR_WEEKLY, MONTHLY, QUARTERLY, WEEKLY, interval } from './interval';
import { type Money, money, negate, scale } from './money';
import { annualEquivalent, costPerUse, monthlyEquivalent, reclaimFrom } from './commitment';

const ASOF = '2026-03-01';

const USD = currency('USD');
const EUR = currency('EUR');
const JPY = currency('JPY');
const KWD = currency('KWD');
const GBP = currency('GBP');

/** The `code` of the LedgerError a thunk throws, or a marker. Keeps the assertion typed. */
function thrownCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return isLedgerError(error) ? error.code : 'NOT_A_LEDGER_ERROR';
  }
  return 'DID_NOT_THROW';
}

function absDelta(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

// ────────────────────────────────────────────────────────────────────────────────────────
// fx
// ────────────────────────────────────────────────────────────────────────────────────────

describe('fx', () => {
  describe('fxRate()', () => {
    it('parses a four-decimal quote into an exact scaled integer', () => {
      const rate = fxRate('USD', 'EUR', '1.2734', ASOF);
      expect(FX_SCALE).toBe(9);
      expect(rate.scaledRate).toBe(1_273_400_000n); // 1.2734 × 10^9
      expect(rate.from).toBe(USD);
      expect(rate.to).toBe(EUR);
      expect(rate.asOf).toBe(ASOF);
    });

    it('parses an integer quote with no decimal point', () => {
      expect(fxRate('USD', 'JPY', '147', ASOF).scaledRate).toBe(147_000_000_000n);
      expect(fxRate('USD', 'EUR', '1', ASOF).scaledRate).toBe(1_000_000_000n);
    });

    it('pads a short fraction rather than misreading its magnitude', () => {
      expect(fxRate('USD', 'EUR', '0.5', ASOF).scaledRate).toBe(500_000_000n);
      expect(fxRate('USD', 'EUR', '0.05', ASOF).scaledRate).toBe(50_000_000n);
      expect(fxRate('JPY', 'USD', '0.0068', ASOF).scaledRate).toBe(6_800_000n);
      expect(fxRate('EUR', 'USD', '1.10', ASOF).scaledRate).toBe(1_100_000_000n);
    });

    it('accepts exactly nine decimal places', () => {
      expect(fxRate('USD', 'EUR', '0.123456789', ASOF).scaledRate).toBe(123_456_789n);
      expect(fxRate('USD', 'EUR', '1.123456789', ASOF).scaledRate).toBe(1_123_456_789n);
    });

    it('rejects a tenth decimal place rather than silently truncating it', () => {
      expect(() => fxRate('USD', 'EUR', '1.1234567891', ASOF)).toThrow(InvalidArgumentError);
      expect(() => fxRate('USD', 'EUR', '1.1234567891', ASOF)).toThrow(/more than 9 decimal places/);
      expect(thrownCode(() => fxRate('USD', 'EUR', '0.0000000001', ASOF))).toBe('INVALID_ARGUMENT');
    });

    it('trims surrounding whitespace', () => {
      expect(fxRate('USD', 'EUR', '  1.5  ', ASOF).scaledRate).toBe(1_500_000_000n);
    });

    it('normalises currency codes to upper case', () => {
      const rate = fxRate('usd', 'eur', '1.1', ASOF);
      expect(rate.from).toBe(USD);
      expect(rate.to).toBe(EUR);
    });

    const REJECTED: readonly { readonly input: string; readonly why: string }[] = [
      { input: '-1.2734', why: 'negative' },
      { input: '-0.5', why: 'negative fraction' },
      { input: '-0', why: 'negative zero' },
      { input: '0', why: 'zero' },
      { input: '0.0', why: 'zero with a fraction' },
      { input: '0.000000000', why: 'zero at full precision' },
      { input: '00', why: 'padded zero' },
      { input: '', why: 'empty' },
      { input: '   ', why: 'whitespace only' },
      { input: 'abc', why: 'non-numeric' },
      { input: 'NaN', why: 'NaN spelled out' },
      { input: 'Infinity', why: 'Infinity spelled out' },
      { input: '1e3', why: 'exponent notation' },
      { input: '1.2.3', why: 'two decimal points' },
      { input: '1,2734', why: 'comma decimal separator' },
      { input: '+1.5', why: 'explicit plus sign' },
      { input: '1.', why: 'trailing decimal point' },
      { input: '.5', why: 'leading decimal point' },
      { input: '1 2', why: 'internal whitespace' },
    ];

    for (const { input, why } of REJECTED) {
      it(`rejects ${JSON.stringify(input)} (${why})`, () => {
        expect(() => fxRate('USD', 'EUR', input, ASOF)).toThrow(InvalidArgumentError);
        expect(thrownCode(() => fxRate('USD', 'EUR', input, ASOF))).toBe('INVALID_ARGUMENT');
      });
    }

    it('rejects currency codes outside the ISO-4217 table', () => {
      expect(() => fxRate('XYZ', 'USD', '1.1', ASOF)).toThrow(UnsupportedCurrencyError);
      expect(thrownCode(() => fxRate('USD', 'XYZ', '1.1', ASOF))).toBe('UNSUPPORTED_CURRENCY');
    });

    it('stores asOf verbatim without validating it', () => {
      // Characterisation, not endorsement: nothing checks the date shape here.
      expect(fxRate('USD', 'EUR', '1.1', 'not-a-date').asOf).toBe('not-a-date');
      expect(fxRate('USD', 'EUR', '1.1', '').asOf).toBe('');
    });
  });

  describe('identityRate()', () => {
    it('is exactly 1 at full scale, both sides the same currency', () => {
      const identity = identityRate('USD', ASOF);
      expect(identity.scaledRate).toBe(1_000_000_000n);
      expect(identity.from).toBe(USD);
      expect(identity.to).toBe(USD);
      expect(identity.asOf).toBe(ASOF);
      expect(identityRate('usd', ASOF).from).toBe(USD);
    });

    it('converts an amount to itself — the identical object, not a copy', () => {
      const dollars = money(1234, 'USD');
      expect(convert(dollars, identityRate('USD', ASOF))).toBe(dollars);
    });

    it('leaves zero-exponent and three-exponent currencies untouched too', () => {
      expect(convert(money(1000, 'JPY'), identityRate('JPY', ASOF)).amountMinor).toBe(1000);
      expect(convert(money(1500, 'KWD'), identityRate('KWD', ASOF)).amountMinor).toBe(1500);
      expect(convert(money(-99, 'GBP'), identityRate('GBP', ASOF)).amountMinor).toBe(-99);
    });

    it('rejects an unknown currency', () => {
      expect(thrownCode(() => identityRate('XYZ', ASOF))).toBe('UNSUPPORTED_CURRENCY');
    });
  });

  describe('invertRate()', () => {
    it('swaps the pair and keeps the as-of date', () => {
      const inverted = invertRate(fxRate('USD', 'EUR', '1.2734', ASOF));
      expect(inverted.from).toBe(EUR);
      expect(inverted.to).toBe(USD);
      expect(inverted.asOf).toBe(ASOF);
    });

    it('computes the reciprocal to nine places, half-even', () => {
      // 10^18 / 1_273_400_000 = 785_299_198 + 12_668/12_734; 12_668/12_734 > ½ ⇒ 785_299_199.
      expect(invertRate(fxRate('USD', 'EUR', '1.2734', ASOF)).scaledRate).toBe(785_299_199n);
      // 10^18 / 920_000_000 = 1_086_956_521 + 17/23; 17/23 > ½ ⇒ 1_086_956_522.
      expect(invertRate(fxRate('USD', 'EUR', '0.92', ASOF)).scaledRate).toBe(1_086_956_522n);
      // Exact reciprocals need no rounding at all.
      expect(invertRate(fxRate('USD', 'EUR', '0.5', ASOF)).scaledRate).toBe(2_000_000_000n);
      expect(invertRate(fxRate('USD', 'EUR', '1', ASOF)).scaledRate).toBe(1_000_000_000n);
      expect(invertRate(fxRate('USD', 'EUR', '0.8', ASOF)).scaledRate).toBe(1_250_000_000n);
    });

    it('returns to within one scaled unit of the original when inverted twice', () => {
      for (const quote of ['1.2734', '1', '0.5', '2', '0.8', '0.0068', '1.09', '0.000001']) {
        const original = fxRate('USD', 'EUR', quote, ASOF);
        const roundTrip = invertRate(invertRate(original));
        expect(roundTrip.from).toBe(USD);
        expect(roundTrip.to).toBe(EUR);
        expect(absDelta(roundTrip.scaledRate, original.scaledRate)).toBeLessThanOrEqual(1n);
      }
    });

    it('property: any rate below 1 survives a double inversion to within one unit', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 999_999_999 }), (scaled) => {
          const quote = `0.${String(scaled).padStart(9, '0')}`;
          const original = fxRate('USD', 'EUR', quote, ASOF);
          expect(original.scaledRate).toBe(BigInt(scaled));
          const roundTrip = invertRate(invertRate(original));
          expect(absDelta(roundTrip.scaledRate, original.scaledRate)).toBeLessThanOrEqual(1n);
        }),
        { numRuns: 300 },
      );
    });

    it('loses precision on a large rate — nine decimal places is the entire budget', () => {
      // 10^18 / 147_250_000_000 = 6_791_171.47… ⇒ 0.006791171, and inverting that does not land
      // back on 147.25 exactly. Documented so nobody assumes invertRate is lossless.
      const usdJpy = fxRate('USD', 'JPY', '147.25', ASOF);
      const roundTrip = invertRate(invertRate(usdJpy));
      expect(invertRate(usdJpy).scaledRate).toBe(6_791_171n);
      expect(roundTrip.scaledRate).not.toBe(usdJpy.scaledRate);
      const drift = Number(absDelta(roundTrip.scaledRate, usdJpy.scaledRate)) / 147_250_000_000;
      expect(drift).toBeLessThan(1e-6);
    });

    it('throws rather than dividing by zero when handed a structurally invalid rate', () => {
      // FxRate is a plain interface, so an object literal bypasses fxRate()'s validation.
      const bogus: FxRate = { from: USD, to: EUR, scaledRate: 0n, asOf: ASOF };
      expect(thrownCode(() => invertRate(bogus))).toBe('INVALID_ARGUMENT');
    });
  });

  describe('convert()', () => {
    it('converts USD to EUR at a known rate, exactly', () => {
      // $19.99 = 1_999 minor. 1_999 × 0.9237 = 1_846.4763 ⇒ half-up ⇒ 1_846 (€18.46).
      const result = convert(money(1999, 'USD'), fxRate('USD', 'EUR', '0.9237', ASOF));
      expect(result.amountMinor).toBe(1846);
      expect(result.currency).toBe(EUR);
    });

    it('converts a round amount with no rounding at all', () => {
      // $100.00 × 0.92 = €92.00 exactly.
      const rate = fxRate('USD', 'EUR', '0.92', ASOF);
      expect(convert(money(10_000, 'USD'), rate).amountMinor).toBe(9200);
    });

    it('JPY→USD crosses a two-digit exponent gap (0 → 2)', () => {
      // ¥10,000 is amountMinor 10_000. × 0.0068 USD/JPY = $68.00 = 6_800 minor units.
      // "amountMinor × rate" would give 68 — one hundredth of the right answer.
      const result = convert(money(10_000, 'JPY'), fxRate('JPY', 'USD', '0.0068', ASOF));
      expect(result.amountMinor).toBe(6800);
      expect(result.currency).toBe(USD);
      expect(result.amountMinor).not.toBe(68);
    });

    it('USD→JPY crosses the same gap the other way (2 → 0)', () => {
      // $25.00 = 2_500 minor. × 147.25 = ¥3,681.25 ⇒ half-up ⇒ ¥3,681 = 3_681 minor units.
      // "amountMinor × rate" would give 368_125 — a hundred times too much.
      const result = convert(money(2500, 'USD'), fxRate('USD', 'JPY', '147.25', ASOF));
      expect(result.amountMinor).toBe(3681);
      expect(result.currency).toBe(JPY);
      expect(result.amountMinor).not.toBe(368_125);
    });

    it('KWD→USD steps down one exponent (3 → 2)', () => {
      // 1.500 KWD = 1_500 fils. × 3.26 = $4.89 = 489 minor units.
      const result = convert(money(1500, 'KWD'), fxRate('KWD', 'USD', '3.26', ASOF));
      expect(result.amountMinor).toBe(489);
      expect(result.currency).toBe(USD);
      expect(result.amountMinor).not.toBe(4890);
    });

    it('USD→KWD steps up one exponent (2 → 3)', () => {
      // $10.00 = 1_000 minor. × 0.3067 = 3.067 KWD = 3_067 fils.
      const result = convert(money(1000, 'USD'), fxRate('USD', 'KWD', '0.3067', ASOF));
      expect(result.amountMinor).toBe(3067);
      expect(result.currency).toBe(KWD);
      expect(result.amountMinor).not.toBe(307);
    });

    it('KWD→USD→KWD lands back on the original three-decimal amount', () => {
      const kwdUsd = fxRate('KWD', 'USD', '3.26', ASOF);
      const dollars = convert(money(1500, 'KWD'), kwdUsd);
      // 489 × 306_748_466 × 10 / 10^9 = 1_499.99999874 ⇒ half-up ⇒ 1_500.
      const back = convert(dollars, invertRate(kwdUsd));
      expect(dollars.amountMinor).toBe(489);
      expect(back.amountMinor).toBe(1500);
      expect(back.currency).toBe(KWD);
    });

    it('refuses a rate that does not start from the amount currency', () => {
      const usdEur = fxRate('USD', 'EUR', '0.92', ASOF);
      expect(() => convert(money(100, 'GBP'), usdEur)).toThrow(InvalidArgumentError);
      expect(() => convert(money(100, 'EUR'), usdEur)).toThrow(/Rate converts USD→EUR/);
      expect(thrownCode(() => convert(money(100, 'GBP'), usdEur))).toBe('INVALID_ARGUMENT');
      // Even the reverse pair is refused — the caller has to invert deliberately.
      expect(thrownCode(() => convert(money(100, 'EUR'), usdEur))).toBe('INVALID_ARGUMENT');
    });

    it('short-circuits a same-currency conversion to the identical object', () => {
      const dollars = money(4999, 'USD');
      expect(convert(dollars, identityRate('USD', ASOF))).toBe(dollars);
      expect(convert(dollars, identityRate('USD', ASOF), 'down')).toBe(dollars);
    });

    it('ignores the scale of a same-currency rate entirely', () => {
      // Characterisation: from === to short-circuits before the rate is read, so a USD→USD
      // rate of 2 is a silent no-op rather than an error.
      const doubling = fxRate('USD', 'USD', '2', ASOF);
      expect(convert(money(100, 'USD'), doubling).amountMinor).toBe(100);
    });

    it('preserves the sign of a negative amount (a refund)', () => {
      const usdEur = fxRate('USD', 'EUR', '0.9237', ASOF);
      const refund = convert(money(-1999, 'USD'), usdEur);
      expect(refund.amountMinor).toBe(-1846);
      expect(refund.currency).toBe(EUR);
      expect(refund).toEqual(negate(convert(money(1999, 'USD'), usdEur)));
    });

    it('converts zero to zero across an exponent gap', () => {
      expect(convert(money(0, 'USD'), fxRate('USD', 'JPY', '147.25', ASOF)).amountMinor).toBe(0);
      expect(convert(money(0, 'JPY'), fxRate('JPY', 'USD', '0.0068', ASOF)).amountMinor).toBe(0);
    });

    it('rounding mode changes the result at an exact .5 boundary', () => {
      // 2 minor × 1.25 = 2.5 exactly — the only place the mode can possibly matter.
      const rate = fxRate('USD', 'EUR', '1.25', ASOF);
      const two = money(2, 'USD');
      expect(convert(two, rate).amountMinor).toBe(3); // default is half-up
      expect(convert(two, rate, 'half-up').amountMinor).toBe(3);
      expect(convert(two, rate, 'half-even').amountMinor).toBe(2); // quotient 2 is even, stay
      expect(convert(two, rate, 'down').amountMinor).toBe(2);
      expect(convert(two, rate, 'up').amountMinor).toBe(3);
    });

    it('half-even rounds an odd quotient up at the same boundary', () => {
      // 1 minor × 1.5 = 1.5; quotient 1 is odd, so half-even goes to 2.
      const rate = fxRate('USD', 'EUR', '1.5', ASOF);
      const one = money(1, 'USD');
      expect(convert(one, rate, 'half-even').amountMinor).toBe(2);
      expect(convert(one, rate, 'half-up').amountMinor).toBe(2);
      expect(convert(one, rate, 'down').amountMinor).toBe(1);
      expect(convert(one, rate, 'up').amountMinor).toBe(2);
    });

    it('rounds negatives by magnitude rather than toward positive infinity', () => {
      const rate = fxRate('USD', 'EUR', '1.25', ASOF);
      expect(convert(money(-2, 'USD'), rate, 'half-up').amountMinor).toBe(-3);
      expect(convert(money(-2, 'USD'), rate, 'half-even').amountMinor).toBe(-2);
      expect(convert(money(-2, 'USD'), rate, 'down').amountMinor).toBe(-2);
      expect(convert(money(-2, 'USD'), rate, 'up').amountMinor).toBe(-3);
      // The float route would not agree: Math.round(-2.5) is -2, breaking the symmetry.
      expect(Math.round(-2.5)).toBe(-2);
    });

    it('never lets a float touch a monetary value — the 1.005 case', () => {
      // 1.005 is stored as 1.00499999999999989…, so the float route rounds $1.00 × 1.005 down
      // to 100 minor units. The bigint route gets exactly 100.5 and rounds it half-up to 101.
      expect(Math.round(100 * 1.005)).toBe(100);
      const rate = fxRate('USD', 'EUR', '1.005', ASOF);
      expect(convert(money(100, 'USD'), rate).amountMinor).toBe(101);
    });

    it('property: every conversion yields a safe integer and is sign-symmetric', () => {
      const usdJpy = fxRate('USD', 'JPY', '147.25', ASOF);
      const jpyUsd = fxRate('JPY', 'USD', '0.0068', ASOF);
      fc.assert(
        fc.property(fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }), (minor) => {
          const toYen = convert(money(minor, 'USD'), usdJpy);
          const toDollars = convert(money(minor, 'JPY'), jpyUsd);
          expect(Number.isSafeInteger(toYen.amountMinor)).toBe(true);
          expect(Number.isSafeInteger(toDollars.amountMinor)).toBe(true);
          expect(Number.isInteger(toYen.amountMinor)).toBe(true);
          const mirrored = convert(negate(money(minor, 'USD')), usdJpy);
          expect(mirrored.amountMinor + toYen.amountMinor).toBe(0);
        }),
        { numRuns: 250 },
      );
    });

    it('refuses to produce an amount outside the safe integer range', () => {
      // 9e15 minor USD × 147.25 ÷ 100 = 1.325e16 minor JPY, past Number.MAX_SAFE_INTEGER.
      const usdJpy = fxRate('USD', 'JPY', '147.25', ASOF);
      expect(thrownCode(() => convert(money(9_000_000_000_000_000, 'USD'), usdJpy))).toBe(
        'MONEY_OVERFLOW',
      );
    });
  });

  describe('staticRateTable()', () => {
    const usdEur = fxRate('USD', 'EUR', '0.92', ASOF);
    const jpyUsd = fxRate('JPY', 'USD', '0.0068', ASOF);
    const table = staticRateTable([usdEur, jpyUsd]);

    it('returns a direct hit unchanged', () => {
      expect(table.find(USD, EUR, ASOF)).toBe(usdEur);
      expect(table.find(JPY, USD, ASOF)).toBe(jpyUsd);
    });

    it('derives the inverse when only the opposite direction is stored', () => {
      const found = table.find(EUR, USD, ASOF);
      if (found === null) throw new Error('expected an inverse rate for EUR→USD');
      expect(found.from).toBe(EUR);
      expect(found.to).toBe(USD);
      expect(found.scaledRate).toBe(1_086_956_522n); // 10^18 / 920_000_000, half-even
      // And it actually converts: €100.00 ÷ 0.92 = $108.6956… ⇒ half-up ⇒ $108.70.
      expect(convert(money(10_000, 'EUR'), found).amountMinor).toBe(10_870);
    });

    it('returns identity for a pair that is the same currency on both sides', () => {
      const found = table.find(GBP, GBP, ASOF);
      if (found === null) throw new Error('expected an identity rate for GBP→GBP');
      expect(found.scaledRate).toBe(1_000_000_000n);
      expect(found.from).toBe(GBP);
      expect(found.to).toBe(GBP);
      // Characterisation: identity comes back with an empty asOf, not the date that was asked for.
      expect(found.asOf).toBe('');
    });

    it('returns null for a pair it cannot reach', () => {
      expect(table.find(GBP, USD, ASOF)).toBeNull();
      expect(table.find(USD, GBP, ASOF)).toBeNull();
      expect(table.find(GBP, KWD, ASOF)).toBeNull();
    });

    it('does not triangulate through a shared currency', () => {
      // JPY→USD and USD→EUR are both present; JPY→EUR is deliberately not derived.
      expect(table.find(JPY, EUR, ASOF)).toBeNull();
    });

    it('ignores the requested date entirely', () => {
      // Characterisation: rates are documented as point-in-time facts, but find() never reads
      // asOf, so a 1999 query returns the 2026 rate.
      expect(table.find(USD, EUR, '1999-01-01')).toBe(usdEur);
    });

    it('is safe on an empty table', () => {
      const empty = staticRateTable([]);
      expect(empty.find(USD, EUR, ASOF)).toBeNull();
      const identity = empty.find(USD, USD, ASOF);
      if (identity === null) throw new Error('expected identity from an empty table');
      expect(identity.scaledRate).toBe(1_000_000_000n);
    });
  });

  describe('sumConverted()', () => {
    const eurUsd = fxRate('EUR', 'USD', '1.10', ASOF);
    const jpyUsd = fxRate('JPY', 'USD', '0.0068', ASOF);
    const table = staticRateTable([eurUsd, jpyUsd]);

    it('totals three currencies into one display currency', () => {
      // $10.00 stays 1_000 · €20.00 × 1.10 = $22.00 = 2_200 · ¥5,000 × 0.0068 = $34.00 = 3_400.
      const { total, unconvertible } = sumConverted(
        [money(1000, 'USD'), money(2000, 'EUR'), money(5000, 'JPY')],
        'USD',
        table,
        ASOF,
      );
      expect(total.amountMinor).toBe(6600);
      expect(total.currency).toBe(USD);
      expect(unconvertible).toEqual([]);
    });

    it('reports an unratable amount instead of dropping it silently', () => {
      const gym = money(900, 'GBP'); // no GBP rate in the table
      const { total, unconvertible } = sumConverted(
        [money(1000, 'USD'), money(2000, 'EUR'), money(5000, 'JPY'), gym],
        'USD',
        table,
        ASOF,
      );
      expect(total.amountMinor).toBe(6600); // excluded from the total…
      expect(unconvertible).toHaveLength(1); // …but handed back, not swallowed
      expect(unconvertible[0]).toBe(gym);
      expect(unconvertible).not.toEqual([]);
      // The other way this goes wrong: coercing £9.00 to $9.00 at 1:1 and reporting $75.00.
      expect(total.amountMinor).not.toBe(7500);
    });

    it('collects every unratable amount, in order', () => {
      const gym = money(900, 'GBP');
      const dinar = money(1500, 'KWD');
      const { total, unconvertible } = sumConverted([gym, money(1000, 'USD'), dinar], 'USD', table, ASOF);
      expect(total.amountMinor).toBe(1000);
      expect(unconvertible).toEqual([gym, dinar]);
    });

    it('accepts a lower-case target string and a branded code alike', () => {
      const amounts = [money(1000, 'USD'), money(2000, 'EUR')];
      expect(sumConverted(amounts, 'usd', table, ASOF).total.amountMinor).toBe(3200);
      expect(sumConverted(amounts, USD, table, ASOF).total.currency).toBe(USD);
    });

    it('converts through an inverse rate when that is all the table holds', () => {
      // Only EUR→USD 1.10 is stored, so USD→EUR is 10^18 / 1_100_000_000 = 909_090_909.09… ⇒
      // 909_090_909, and $22.00 × that = 1_999.9999998 ⇒ half-up ⇒ €20.00.
      const { total, unconvertible } = sumConverted([money(2200, 'USD')], 'EUR', table, ASOF);
      expect(total.amountMinor).toBe(2000);
      expect(unconvertible).toEqual([]);
    });

    it('nets a refund against the charges it belongs to', () => {
      // €20.00 → $22.00 and −€10.00 → −$11.00.
      const { total } = sumConverted([money(2000, 'EUR'), money(-1000, 'EUR')], 'USD', table, ASOF);
      expect(total.amountMinor).toBe(1100);
    });

    it('returns a zero total for an empty list', () => {
      const { total, unconvertible } = sumConverted([], 'USD', table, ASOF);
      expect(total.amountMinor).toBe(0);
      expect(total.currency).toBe(USD);
      expect(unconvertible).toEqual([]);
    });

    it('rejects an unknown target currency', () => {
      expect(thrownCode(() => sumConverted([], 'XYZ', table, ASOF))).toBe('UNSUPPORTED_CURRENCY');
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// commitment
// ────────────────────────────────────────────────────────────────────────────────────────

describe('commitment', () => {
  const gbp = (minor: number): Money => money(minor, 'GBP');

  describe('monthlyEquivalent() / annualEquivalent()', () => {
    it('monthly £9.99 is £9.99 a month and £119.88 a year', () => {
      expect(monthlyEquivalent(gbp(999), MONTHLY).amountMinor).toBe(999);
      expect(annualEquivalent(gbp(999), MONTHLY).amountMinor).toBe(11_988); // 999 × 12
      expect(annualEquivalent(gbp(999), MONTHLY).currency).toBe(GBP);
    });

    it('annual £119.88 is £9.99 a month, exactly', () => {
      expect(monthlyEquivalent(gbp(11_988), ANNUAL).amountMinor).toBe(999); // 11_988 ÷ 12
      expect(annualEquivalent(gbp(11_988), ANNUAL).amountMinor).toBe(11_988);
    });

    it('quarterly £29.97 is £9.99 a month and £119.88 a year', () => {
      expect(monthlyEquivalent(gbp(2997), QUARTERLY).amountMinor).toBe(999); // 2_997 × 12 ÷ 36
      expect(annualEquivalent(gbp(2997), QUARTERLY).amountMinor).toBe(11_988); // 2_997 × 12 ÷ 3
    });

    it('weekly £2.50 annualises at 365/7 charges, not 52', () => {
      // 250 × 365 = 91_250. ÷ 7 = 13_035.71 ⇒ half-even ⇒ 13_036 (£130.36).
      expect(annualEquivalent(gbp(250), WEEKLY).amountMinor).toBe(13_036);
      expect(annualEquivalent(gbp(250), WEEKLY).amountMinor).not.toBe(52 * 250);
      // ÷ 84 = 1_086.31 ⇒ 1_086 (£10.86 a month).
      expect(monthlyEquivalent(gbp(250), WEEKLY).amountMinor).toBe(1086);
    });

    it('£8.99 every 4 weeks is about 13 charges a year, not 12', () => {
      // 365/28 = 13.0357 charges. 899 × 365 = 328_135; ÷ 28 = 11_719.107 ⇒ 11_719 (£117.19).
      const annual = annualEquivalent(gbp(899), FOUR_WEEKLY);
      expect(annual.amountMinor).toBe(11_719);
      // Treating 4-weekly as monthly gives £107.88 — £9.31 light, very nearly one whole extra
      // charge the user was never shown.
      expect(annual.amountMinor).not.toBe(12 * 899);
      expect(annual.amountMinor - 12 * 899).toBe(931);
      expect(annual.amountMinor).toBeGreaterThan(13 * 899); // 11_687
      expect(annual.amountMinor).toBeLessThan(14 * 899); // 12_586
      // 328_135 ÷ 336 = 976.59 ⇒ half-even ⇒ 977 (£9.77 a month).
      expect(monthlyEquivalent(gbp(899), FOUR_WEEKLY).amountMinor).toBe(977);
    });

    it('4-weekly and monthly are different numbers for the same headline price', () => {
      expect(annualEquivalent(gbp(899), FOUR_WEEKLY).amountMinor).toBe(11_719);
      expect(annualEquivalent(gbp(899), MONTHLY).amountMinor).toBe(10_788);
      expect(monthlyEquivalent(gbp(899), FOUR_WEEKLY).amountMinor).toBe(977);
      expect(monthlyEquivalent(gbp(899), MONTHLY).amountMinor).toBe(899);
    });

    it('works in a currency with no minor unit at all', () => {
      // ¥500 every 4 weeks: 500 × 365 = 182_500; ÷ 28 = 6_517.86 ⇒ ¥6_518; ÷ 336 = 543.15 ⇒ ¥543.
      expect(annualEquivalent(money(500, 'JPY'), FOUR_WEEKLY).amountMinor).toBe(6518);
      expect(monthlyEquivalent(money(500, 'JPY'), FOUR_WEEKLY).amountMinor).toBe(543);
      expect(annualEquivalent(money(1200, 'JPY'), MONTHLY).amountMinor).toBe(14_400);
      expect(annualEquivalent(money(1200, 'JPY'), MONTHLY).currency).toBe(JPY);
    });

    it('defaults to half-even so summed rows do not drift upward', () => {
      // £0.30 a year ÷ 12 = 2.5 minor units. half-even keeps the even 2; half-up would say 3.
      expect(monthlyEquivalent(gbp(30), ANNUAL).amountMinor).toBe(2);
      expect(monthlyEquivalent(gbp(30), ANNUAL, 'half-up').amountMinor).toBe(3);
      expect(monthlyEquivalent(gbp(30), ANNUAL, 'down').amountMinor).toBe(2);
      expect(monthlyEquivalent(gbp(30), ANNUAL, 'up').amountMinor).toBe(3);
    });

    it('half-even still rounds an odd quotient up', () => {
      // £0.18 ÷ 12 = 1.5 minor units; quotient 1 is odd ⇒ 2.
      expect(monthlyEquivalent(gbp(18), ANNUAL).amountMinor).toBe(2);
      expect(monthlyEquivalent(gbp(18), ANNUAL, 'down').amountMinor).toBe(1);
      expect(monthlyEquivalent(gbp(18), ANNUAL, 'up').amountMinor).toBe(2);
    });

    it('honours an explicit mode when annualising', () => {
      // 91_250 ÷ 7 = 13_035.71.
      expect(annualEquivalent(gbp(250), WEEKLY, 'down').amountMinor).toBe(13_035);
      expect(annualEquivalent(gbp(250), WEEKLY, 'up').amountMinor).toBe(13_036);
      expect(annualEquivalent(gbp(250), WEEKLY, 'half-up').amountMinor).toBe(13_036);
      expect(annualEquivalent(gbp(250), WEEKLY, 'half-even').amountMinor).toBe(13_036);
    });

    it('keeps the currency, the sign, and zero', () => {
      expect(monthlyEquivalent(gbp(899), FOUR_WEEKLY).currency).toBe(GBP);
      expect(monthlyEquivalent(gbp(-899), FOUR_WEEKLY).amountMinor).toBe(-977);
      expect(annualEquivalent(gbp(-899), FOUR_WEEKLY).amountMinor).toBe(-11_719);
      expect(annualEquivalent(gbp(0), FOUR_WEEKLY).amountMinor).toBe(0);
      expect(monthlyEquivalent(gbp(0), WEEKLY).amountMinor).toBe(0);
    });

    it('handles an arbitrary interval, not just the presets', () => {
      // Every 5 months: 12/5 charges a year. £50.00 ⇒ 5_000 × 12 ÷ 5 = 12_000 (£120.00) a year,
      // and 5_000 × 12 ÷ 60 = 1_000 (£10.00) a month.
      const everyFiveMonths = interval('month', 5);
      expect(annualEquivalent(gbp(5000), everyFiveMonths).amountMinor).toBe(12_000);
      expect(monthlyEquivalent(gbp(5000), everyFiveMonths).amountMinor).toBe(1000);
      // Daily £1.00: 365 charges a year, 365/12 = 30.42 a month ⇒ 100 × 365 ÷ 12 = 3_041.67 ⇒ 3_042.
      expect(annualEquivalent(gbp(100), interval('day', 1)).amountMinor).toBe(36_500);
      expect(monthlyEquivalent(gbp(100), interval('day', 1)).amountMinor).toBe(3042);
      // Every 2 years: half a charge a year.
      expect(annualEquivalent(gbp(12_000), interval('year', 2)).amountMinor).toBe(6000);
    });
  });

  describe('costPerUse()', () => {
    it('divides the spend across the uses', () => {
      // £17.99 opened twice: 1_799 ÷ 2 = 899.5 ⇒ half-up ⇒ 900 (£9.00 a session).
      const result = costPerUse(gbp(1799), 2);
      expect(result?.amountMinor).toBe(900);
      expect(result?.currency).toBe(GBP);
    });

    it('divides exactly when it can', () => {
      expect(costPerUse(gbp(1799), 7)?.amountMinor).toBe(257); // 7 × 257 = 1_799
      expect(costPerUse(gbp(1799), 1)?.amountMinor).toBe(1799);
      expect(costPerUse(gbp(1799), 3)?.amountMinor).toBe(600); // 599.67 ⇒ 600
      expect(costPerUse(gbp(1000), 4)?.amountMinor).toBe(250);
    });

    it('returns null for zero uses rather than an infinity', () => {
      expect(costPerUse(gbp(1799), 0)).toBeNull();
      expect(costPerUse(gbp(1799), -0)).toBeNull();
      expect(costPerUse(gbp(0), 0)).toBeNull();
    });

    it('returns null for a negative use count', () => {
      expect(costPerUse(gbp(1799), -1)).toBeNull();
      expect(costPerUse(gbp(1799), -12)).toBeNull();
    });

    it('returns null for a non-integer use count', () => {
      expect(costPerUse(gbp(1799), 2.5)).toBeNull();
      expect(costPerUse(gbp(1799), 0.5)).toBeNull();
      expect(costPerUse(gbp(1799), Number.NaN)).toBeNull();
      expect(costPerUse(gbp(1799), Number.POSITIVE_INFINITY)).toBeNull();
      expect(costPerUse(gbp(1799), Number.NEGATIVE_INFINITY)).toBeNull();
    });

    it('splits a refund the same way and is zero-safe on the spend', () => {
      expect(costPerUse(gbp(-1000), 4)?.amountMinor).toBe(-250);
      expect(costPerUse(gbp(0), 3)?.amountMinor).toBe(0);
    });

    it('works in a currency with no minor unit', () => {
      // ¥1,000 over 3 uses: 333.33 ⇒ half-up ⇒ ¥333.
      expect(costPerUse(money(1000, 'JPY'), 3)?.amountMinor).toBe(333);
      expect(costPerUse(money(1000, 'JPY'), 3)?.currency).toBe(JPY);
    });
  });

  describe('reclaimFrom()', () => {
    it('returns both figures, each matching its own helper', () => {
      const price = gbp(899);
      const reclaim = reclaimFrom(price, FOUR_WEEKLY);
      expect(reclaim.monthly).toEqual(monthlyEquivalent(price, FOUR_WEEKLY));
      expect(reclaim.annual).toEqual(annualEquivalent(price, FOUR_WEEKLY));
      expect(reclaim.monthly.amountMinor).toBe(977);
      expect(reclaim.annual.amountMinor).toBe(11_719);
    });

    it('uses the half-even default for both figures', () => {
      const reclaim = reclaimFrom(gbp(30), ANNUAL);
      expect(reclaim.monthly.amountMinor).toBe(2); // 2.5 ⇒ half-even ⇒ 2
      expect(reclaim.annual.amountMinor).toBe(30);
    });

    it('keeps the currency of the subscription', () => {
      const reclaim = reclaimFrom(money(1200, 'JPY'), MONTHLY);
      expect(reclaim.monthly.currency).toBe(JPY);
      expect(reclaim.monthly.amountMinor).toBe(1200);
      expect(reclaim.annual.amountMinor).toBe(14_400);
    });
  });

  describe('round-trip properties', () => {
    it('annualising a monthly price and dividing by twelve returns the original', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 100_000_000 }), (minor) => {
          const original = gbp(minor);
          const back = scale(annualEquivalent(original, MONTHLY), 1, 12, 'half-even');
          expect(Math.abs(back.amountMinor - original.amountMinor)).toBeLessThanOrEqual(1);
          expect(back.amountMinor).toBe(original.amountMinor);
          expect(Number.isSafeInteger(back.amountMinor)).toBe(true);
        }),
        { numRuns: 500 },
      );
    });

    it('twelve monthly equivalents stay within a few minor units of the annual figure', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -1_000_000, max: 1_000_000 }),
          fc.constantFrom(WEEKLY, FOUR_WEEKLY, MONTHLY, QUARTERLY, ANNUAL),
          (minor, value) => {
            const amount = gbp(minor);
            const monthly = monthlyEquivalent(amount, value);
            const annual = annualEquivalent(amount, value);
            expect(Number.isInteger(monthly.amountMinor)).toBe(true);
            expect(Number.isInteger(annual.amountMinor)).toBe(true);
            expect(Math.abs(annual.amountMinor - 12 * monthly.amountMinor)).toBeLessThanOrEqual(12);
          },
        ),
        { numRuns: 300 },
      );
    });

    it('property: 4-weekly always annualises above the 12-charge reading', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1000, max: 10_000_000 }), (minor) => {
          const annual = annualEquivalent(gbp(minor), FOUR_WEEKLY);
          expect(annual.amountMinor).toBeGreaterThan(12 * minor);
          expect(annual.amountMinor).toBeLessThan(14 * minor);
        }),
        { numRuns: 300 },
      );
    });
  });
});
