/**
 * Tests for money.ts and currency.ts.
 *
 * Brief §11: money is an integer count of minor units and no float ever touches a monetary
 * value, so these tests assert the integer-ness of every result as well as its value.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  type CurrencyCode,
  allCurrencies,
  currency,
  currencyDefinition,
  isCurrencyCode,
  minorUnitExponent,
  minorUnitsPerMajor,
} from './currency';
import {
  CurrencyMismatchError,
  InvalidArgumentError,
  LedgerError,
  isLedgerError,
} from './errors';
import {
  type Money,
  type RoundingMode,
  abs,
  add,
  allocate,
  allocateByWeights,
  bpsToPercentString,
  compare,
  divideRound,
  equals,
  formatMoney,
  isNegative,
  isPositive,
  isZero,
  max,
  min,
  money,
  multiply,
  negate,
  parseMoney,
  relativeChangeBps,
  scale,
  subtract,
  sum,
  toDecimalString,
  toMajorNumber,
  zero,
} from './money';

// ── helpers ────────────────────────────────────────────────────────────────────────────

/** Captures the LedgerError a thunk throws so its `code` and `meta` can be inspected. */
function caught(thunk: () => unknown): LedgerError {
  try {
    thunk();
  } catch (error) {
    if (isLedgerError(error)) return error;
    throw error;
  }
  throw new Error('expected the thunk to throw a LedgerError, but it returned normally');
}

/** Intl inserts NBSP / narrow NBSP between parts; normalise so assertions stay readable. */
function normaliseSpaces(value: string): string {
  return value.replace(/\s/g, ' ');
}

const minorUnits = (parts: readonly Money[]): number[] => parts.map((part) => part.amountMinor);

const totalMinor = (parts: readonly Money[]): number =>
  parts.reduce((acc, part) => acc + part.amountMinor, 0);

const ROUNDING_MODES: readonly RoundingMode[] = ['half-up', 'half-even', 'down', 'up'];

/** One currency of each exponent, so every property covers 0, 2 and 3 minor digits. */
const CURRENCY_SAMPLE = ['USD', 'EUR', 'GBP', 'JPY', 'ISK', 'KWD', 'BHD'] as const;
const currencyArb = fc.constantFrom(...CURRENCY_SAMPLE);
/** Wide enough to be interesting, far enough from 2**53 that nothing overflows mid-property. */
const amountArb = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 });

// ── currency.ts ────────────────────────────────────────────────────────────────────────

describe('currency()', () => {
  it('brands a valid uppercase code', () => {
    const code = currency('USD');
    expect(code).toBe('USD');
  });

  it('normalises lowercase and mixed-case input', () => {
    expect(currency('usd')).toBe('USD');
    expect(currency('jPy')).toBe('JPY');
    expect(currency('kwd')).toBe('KWD');
  });

  it('throws UnsupportedCurrencyError for an unknown code', () => {
    const error = caught(() => currency('XYZ'));
    expect(error.name).toBe('UnsupportedCurrencyError');
    expect(error.code).toBe('UNSUPPORTED_CURRENCY');
    expect(error.meta).toEqual({ code: 'XYZ' });
    expect(error.message).toContain('XYZ');
  });

  it('throws for the empty string and for obviously wrong shapes', () => {
    expect(() => currency('')).toThrow(LedgerError);
    expect(() => currency('US')).toThrow(LedgerError);
    expect(() => currency('DOLLARS')).toThrow(LedgerError);
  });

  it('accepts every code in the published table', () => {
    for (const definition of allCurrencies()) {
      expect(currency(definition.code)).toBe(definition.code);
      expect(currency(definition.code.toLowerCase())).toBe(definition.code);
    }
  });
});

describe('isCurrencyCode()', () => {
  it('is true for known codes in any case', () => {
    expect(isCurrencyCode('USD')).toBe(true);
    expect(isCurrencyCode('usd')).toBe(true);
    expect(isCurrencyCode('KwD')).toBe(true);
  });

  it('is false for unknown codes and does not throw', () => {
    expect(isCurrencyCode('XYZ')).toBe(false);
    expect(isCurrencyCode('')).toBe(false);
    expect(isCurrencyCode('BTC')).toBe(false);
  });
});

describe('currencyDefinition()', () => {
  it('returns the full definition', () => {
    expect(currencyDefinition(currency('KWD'))).toEqual({
      code: 'KWD',
      exponent: 3,
      name: 'Kuwaiti Dinar',
    });
    expect(currencyDefinition(currency('JPY'))).toEqual({ code: 'JPY', exponent: 0, name: 'Yen' });
  });

  it('throws when handed a branded code that is not in the table', () => {
    const forged = 'ZZZ' as unknown as CurrencyCode;
    const error = caught(() => currencyDefinition(forged));
    expect(error.code).toBe('UNSUPPORTED_CURRENCY');
  });
});

describe('minor-unit exponents', () => {
  it('is 2 for USD, 0 for JPY, 3 for KWD', () => {
    expect(minorUnitExponent(currency('USD'))).toBe(2);
    expect(minorUnitExponent(currency('JPY'))).toBe(0);
    expect(minorUnitExponent(currency('KWD'))).toBe(3);
  });

  it('derives minorUnitsPerMajor as 10 ** exponent', () => {
    expect(minorUnitsPerMajor(currency('USD'))).toBe(100);
    expect(minorUnitsPerMajor(currency('JPY'))).toBe(1);
    expect(minorUnitsPerMajor(currency('KWD'))).toBe(1000);
    expect(minorUnitsPerMajor(currency('ISK'))).toBe(1);
    expect(minorUnitsPerMajor(currency('BHD'))).toBe(1000);
  });

  it('publishes a table of unique uppercase codes with exponents 0, 2 or 3', () => {
    const definitions = allCurrencies();
    expect(definitions.length).toBeGreaterThan(0);
    const codes = definitions.map((definition) => definition.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const definition of definitions) {
      expect(definition.code).toMatch(/^[A-Z]{3}$/);
      expect([0, 2, 3]).toContain(definition.exponent);
      expect(definition.name.length).toBeGreaterThan(0);
    }
  });
});

// ── construction ───────────────────────────────────────────────────────────────────────

describe('money()', () => {
  it('builds a money value from integer minor units', () => {
    const value = money(1299, 'USD');
    expect(value).toEqual({ amountMinor: 1299, currency: 'USD' });
  });

  it('normalises the currency code', () => {
    expect(money(1299, 'usd').currency).toBe('USD');
  });

  it('accepts negative amounts (refunds)', () => {
    const refund = money(-1299, 'USD');
    expect(refund.amountMinor).toBe(-1299);
    expect(isNegative(refund)).toBe(true);
  });

  it('accepts zero and the safe-integer boundary', () => {
    expect(money(0, 'USD').amountMinor).toBe(0);
    expect(money(Number.MAX_SAFE_INTEGER, 'USD').amountMinor).toBe(Number.MAX_SAFE_INTEGER);
    expect(money(-Number.MAX_SAFE_INTEGER, 'USD').amountMinor).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it('rejects fractional amounts — a float leaked in upstream', () => {
    const error = caught(() => money(12.99, 'USD'));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('integer count of minor units');
  });

  it('rejects NaN and Infinity', () => {
    expect(() => money(Number.NaN, 'USD')).toThrow(InvalidArgumentError);
    expect(() => money(Number.POSITIVE_INFINITY, 'USD')).toThrow(InvalidArgumentError);
    expect(() => money(Number.NEGATIVE_INFINITY, 'USD')).toThrow(InvalidArgumentError);
  });

  it('rejects integers beyond the safe range with MONEY_OVERFLOW', () => {
    const error = caught(() => money(2 ** 53, 'USD'));
    expect(error.code).toBe('MONEY_OVERFLOW');
    expect(() => money(-(2 ** 53), 'USD')).toThrow(LedgerError);
  });

  it('rejects an unknown currency', () => {
    expect(() => money(100, 'XYZ')).toThrow(LedgerError);
  });
});

describe('zero()', () => {
  it('is zero in the requested currency', () => {
    expect(zero('USD')).toEqual({ amountMinor: 0, currency: 'USD' });
    expect(zero('jpy')).toEqual({ amountMinor: 0, currency: 'JPY' });
    expect(isZero(zero('KWD'))).toBe(true);
  });

  it('rejects an unknown currency', () => {
    expect(() => zero('XYZ')).toThrow(LedgerError);
  });
});

// ── parseMoney ─────────────────────────────────────────────────────────────────────────

describe('parseMoney()', () => {
  it('parses a plain decimal', () => {
    expect(parseMoney('12.99', 'USD').amountMinor).toBe(1299);
  });

  it('treats a comma group as thousands, not as a decimal: "1,299.00" is 129900 minor', () => {
    expect(parseMoney('1,299.00', 'USD').amountMinor).toBe(129900);
    expect(parseMoney('1,299', 'USD').amountMinor).toBe(129900);
    expect(parseMoney('$1,234,567.89', 'USD').amountMinor).toBe(123456789);
  });

  it('parses a European decimal comma', () => {
    expect(parseMoney('12,99', 'USD').amountMinor).toBe(1299);
    expect(parseMoney('1 299,00', 'EUR').amountMinor).toBe(129900);
    expect(parseMoney('1.299,00', 'EUR').amountMinor).toBe(129900);
  });

  it('strips currency symbols and surrounding whitespace', () => {
    expect(parseMoney('€12.99', 'EUR').amountMinor).toBe(1299);
    expect(parseMoney('  $12.99  ', 'USD').amountMinor).toBe(1299);
    expect(parseMoney('£10.00', 'GBP').amountMinor).toBe(1000);
    expect(parseMoney('USD 12.99', 'USD').amountMinor).toBe(1299);
  });

  it('parses negative and explicitly positive amounts', () => {
    expect(parseMoney('-5.00', 'USD').amountMinor).toBe(-500);
    expect(parseMoney('+12.99', 'USD').amountMinor).toBe(1299);
    expect(parseMoney('-0.01', 'USD').amountMinor).toBe(-1);
  });

  it('pads a short fraction: "1.5" at USD is 150 minor', () => {
    expect(parseMoney('1.5', 'USD').amountMinor).toBe(150);
    expect(parseMoney('1.', 'USD').amountMinor).toBe(100);
    expect(parseMoney('.99', 'USD').amountMinor).toBe(99);
  });

  it('rounds a long fraction half-up rather than truncating', () => {
    // Four fraction digits, so the thousands-separator heuristic does not fire.
    expect(parseMoney('12.9960', 'USD').amountMinor).toBe(1300);
    expect(parseMoney('12.9949', 'USD').amountMinor).toBe(1299);
    expect(parseMoney('1.2345', 'USD').amountMinor).toBe(123);
    expect(parseMoney('1,299.996', 'USD').amountMinor).toBe(130000);
  });

  it('BUG: "12.996" at a 2-digit currency is read as a thousands group, not 13.00', () => {
    // The "exactly three trailing digits and one separator" heuristic that makes "1,299" mean
    // one-thousand-two-hundred-ninety-nine also swallows a legitimate three-decimal input:
    // "12.996" parses as 12996 major units. Documented here as observed behaviour, not endorsed.
    expect(parseMoney('12.996', 'USD').amountMinor).toBe(1299600);
    expect(parseMoney('0.100', 'USD').amountMinor).toBe(10000);
  });

  it('respects the exponent: JPY has no minor unit', () => {
    expect(parseMoney('1000', 'JPY').amountMinor).toBe(1000);
    expect(parseMoney('¥1,000', 'JPY').amountMinor).toBe(1000);
    expect(parseMoney('-1000', 'JPY').amountMinor).toBe(-1000);
  });

  it('respects the exponent: KWD has three minor digits', () => {
    expect(parseMoney('1.234', 'KWD').amountMinor).toBe(1234);
    expect(parseMoney('12.996', 'KWD').amountMinor).toBe(12996);
    // At exponent 3 the thousands heuristic is disabled, so "1,234" means 1.234 KWD.
    expect(parseMoney('1,234', 'KWD').amountMinor).toBe(1234);
    expect(parseMoney('1.2345', 'KWD').amountMinor).toBe(1235);
  });

  it('parses zero in every form', () => {
    expect(parseMoney('0', 'USD').amountMinor).toBe(0);
    expect(parseMoney('0.00', 'USD').amountMinor).toBe(0);
    expect(parseMoney('0', 'JPY').amountMinor).toBe(0);
  });

  it('throws InvalidArgumentError on garbage input', () => {
    const error = caught(() => parseMoney('abc', 'USD'));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error.message).toContain('Cannot read an amount');
    expect(() => parseMoney('', 'USD')).toThrow(InvalidArgumentError);
    expect(() => parseMoney('   ', 'USD')).toThrow(InvalidArgumentError);
    expect(() => parseMoney('-', 'USD')).toThrow(InvalidArgumentError);
    expect(() => parseMoney('+', 'USD')).toThrow(InvalidArgumentError);
    expect(() => parseMoney('$', 'USD')).toThrow(InvalidArgumentError);
  });

  it('throws when a sign appears inside the number', () => {
    expect(() => parseMoney('1-2', 'USD')).toThrow(InvalidArgumentError);
    expect(() => parseMoney('1.2-', 'USD')).toThrow(InvalidArgumentError);
    expect(() => parseMoney('1.2+3', 'USD')).toThrow(InvalidArgumentError);
  });

  it('rejects an unknown currency before looking at the number', () => {
    expect(() => parseMoney('12.99', 'XYZ')).toThrow(LedgerError);
  });

  it('refuses amounts past the safe integer range', () => {
    const error = caught(() => parseMoney('99999999999999999999.99', 'USD'));
    expect(error.code).toBe('MONEY_OVERFLOW');
  });

  it('always yields an exact integer, never a float', () => {
    for (const input of ['0.1', '0.2', '0.3', '0.07', '1.15', '8.75', '1234.56']) {
      const parsed = parseMoney(input, 'USD');
      expect(Number.isInteger(parsed.amountMinor)).toBe(true);
    }
    expect(parseMoney('0.1', 'USD').amountMinor).toBe(10);
    expect(parseMoney('1.15', 'USD').amountMinor).toBe(115);
  });
});

// ── arithmetic ─────────────────────────────────────────────────────────────────────────

describe('add() / subtract()', () => {
  it('adds and subtracts minor units', () => {
    expect(add(money(1299, 'USD'), money(1, 'USD')).amountMinor).toBe(1300);
    expect(subtract(money(1299, 'USD'), money(300, 'USD')).amountMinor).toBe(999);
    expect(subtract(money(300, 'USD'), money(1299, 'USD')).amountMinor).toBe(-999);
  });

  it('carries the currency through', () => {
    expect(add(money(1, 'JPY'), money(2, 'JPY'))).toEqual({ amountMinor: 3, currency: 'JPY' });
  });

  it('throws CurrencyMismatchError on mixed currencies', () => {
    const error = caught(() => add(money(100, 'USD'), money(100, 'EUR')));
    expect(error).toBeInstanceOf(CurrencyMismatchError);
    expect(error.code).toBe('CURRENCY_MISMATCH');
    expect(error.meta).toEqual({ left: 'USD', right: 'EUR' });
    expect(() => subtract(money(100, 'USD'), money(100, 'GBP'))).toThrow(CurrencyMismatchError);
  });

  it('throws MONEY_OVERFLOW rather than silently losing precision', () => {
    const huge = money(Number.MAX_SAFE_INTEGER, 'USD');
    expect(caught(() => add(huge, money(1, 'USD'))).code).toBe('MONEY_OVERFLOW');
    expect(caught(() => subtract(negate(huge), money(1, 'USD'))).code).toBe('MONEY_OVERFLOW');
  });

  it('adds exact decimals that a float would get wrong', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    const exact = add(parseMoney('0.1', 'USD'), parseMoney('0.2', 'USD'));
    expect(exact.amountMinor).toBe(30);
    expect(equals(exact, parseMoney('0.30', 'USD'))).toBe(true);
  });
});

describe('negate() / abs()', () => {
  it('negates in both directions', () => {
    expect(negate(money(1299, 'USD')).amountMinor).toBe(-1299);
    expect(negate(money(-1299, 'USD')).amountMinor).toBe(1299);
    expect(isZero(negate(zero('USD')))).toBe(true);
  });

  it('takes the magnitude', () => {
    expect(abs(money(-1299, 'USD')).amountMinor).toBe(1299);
    expect(abs(money(1299, 'USD')).amountMinor).toBe(1299);
    expect(abs(zero('USD')).amountMinor).toBe(0);
  });

  it('keeps the currency', () => {
    expect(negate(money(5, 'KWD')).currency).toBe('KWD');
    expect(abs(money(-5, 'JPY')).currency).toBe('JPY');
  });
});

describe('multiply()', () => {
  it('multiplies by an integer factor', () => {
    expect(multiply(money(999, 'USD'), 12).amountMinor).toBe(11988);
    expect(multiply(money(999, 'USD'), 0).amountMinor).toBe(0);
    expect(multiply(money(999, 'USD'), -1).amountMinor).toBe(-999);
    expect(multiply(money(-250, 'USD'), 4).amountMinor).toBe(-1000);
  });

  it('rejects a non-integer factor and points at scale()', () => {
    const error = caught(() => multiply(money(1000, 'USD'), 1.5));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error.message).toContain('scale()');
    expect(() => multiply(money(1000, 'USD'), Number.NaN)).toThrow(InvalidArgumentError);
  });

  it('throws MONEY_OVERFLOW past the safe range', () => {
    expect(caught(() => multiply(money(Number.MAX_SAFE_INTEGER, 'USD'), 2)).code).toBe(
      'MONEY_OVERFLOW',
    );
  });
});

describe('scale()', () => {
  it('applies a rational rate exactly when it divides', () => {
    expect(scale(money(1000, 'USD'), 75, 1000).amountMinor).toBe(75);
    expect(scale(money(2000, 'USD'), 1, 2).amountMinor).toBe(1000);
    expect(scale(money(1299, 'USD'), 2, 1).amountMinor).toBe(2598);
  });

  it('defaults to half-up rounding', () => {
    expect(scale(money(5, 'USD'), 1, 2).amountMinor).toBe(3);
    expect(scale(money(1000, 'USD'), 1, 3).amountMinor).toBe(333);
  });

  it('honours every rounding mode', () => {
    const value = money(5, 'USD');
    expect(scale(value, 1, 2, 'half-up').amountMinor).toBe(3);
    expect(scale(value, 1, 2, 'half-even').amountMinor).toBe(2);
    expect(scale(value, 1, 2, 'down').amountMinor).toBe(2);
    expect(scale(value, 1, 2, 'up').amountMinor).toBe(3);
    expect(scale(money(1000, 'USD'), 1, 3, 'up').amountMinor).toBe(334);
    expect(scale(money(1000, 'USD'), 1, 3, 'down').amountMinor).toBe(333);
    expect(scale(money(1000, 'USD'), 1, 3, 'half-even').amountMinor).toBe(333);
  });

  it('rounds negatives symmetrically around zero', () => {
    expect(scale(money(-1000, 'USD'), 1, 3, 'down').amountMinor).toBe(-333);
    expect(scale(money(-1000, 'USD'), 1, 3, 'up').amountMinor).toBe(-334);
    expect(scale(money(-5, 'USD'), 1, 2, 'half-up').amountMinor).toBe(-3);
    expect(scale(money(-5, 'USD'), 1, 2, 'half-even').amountMinor).toBe(-2);
  });

  it('rejects non-integer numerator or denominator', () => {
    expect(() => scale(money(1000, 'USD'), 0.075, 1)).toThrow(InvalidArgumentError);
    expect(() => scale(money(1000, 'USD'), 75, 1000.5)).toThrow(InvalidArgumentError);
  });

  it('rejects a zero denominator', () => {
    const error = caught(() => scale(money(1000, 'USD'), 1, 0));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error.message).toContain('denominator must not be zero');
  });

  it('keeps the currency and stays an integer', () => {
    const result = scale(money(1234, 'KWD'), 1, 7);
    expect(result.currency).toBe('KWD');
    expect(Number.isInteger(result.amountMinor)).toBe(true);
  });

  it('overflows loudly rather than wrapping', () => {
    expect(caught(() => scale(money(Number.MAX_SAFE_INTEGER, 'USD'), 3, 1)).code).toBe(
      'MONEY_OVERFLOW',
    );
  });
});

// ── divideRound ────────────────────────────────────────────────────────────────────────

describe('divideRound()', () => {
  it('short-circuits exact division in every mode', () => {
    for (const mode of ROUNDING_MODES) {
      expect(divideRound(10n, 2n, mode)).toBe(5n);
      expect(divideRound(-10n, 2n, mode)).toBe(-5n);
      expect(divideRound(10n, -2n, mode)).toBe(-5n);
      expect(divideRound(-10n, -2n, mode)).toBe(5n);
      expect(divideRound(0n, 7n, mode)).toBe(0n);
    }
  });

  it("rounds 'down' toward zero", () => {
    expect(divideRound(7n, 2n, 'down')).toBe(3n);
    expect(divideRound(-7n, 2n, 'down')).toBe(-3n);
    expect(divideRound(1n, 3n, 'down')).toBe(0n);
    expect(divideRound(-1n, 3n, 'down')).toBe(0n);
  });

  it("rounds 'up' away from zero", () => {
    expect(divideRound(7n, 2n, 'up')).toBe(4n);
    expect(divideRound(-7n, 2n, 'up')).toBe(-4n);
    expect(divideRound(1n, 3n, 'up')).toBe(1n);
    expect(divideRound(-1n, 3n, 'up')).toBe(-1n);
  });

  it("rounds 'half-up' away from zero at the midpoint", () => {
    expect(divideRound(5n, 2n, 'half-up')).toBe(3n);
    expect(divideRound(7n, 2n, 'half-up')).toBe(4n);
    expect(divideRound(-5n, 2n, 'half-up')).toBe(-3n);
    expect(divideRound(1n, 3n, 'half-up')).toBe(0n);
    expect(divideRound(2n, 3n, 'half-up')).toBe(1n);
    expect(divideRound(-2n, 3n, 'half-up')).toBe(-1n);
  });

  it("rounds 'half-even' to the nearest even at the midpoint: 2.5 -> 2, 3.5 -> 4", () => {
    expect(divideRound(5n, 2n, 'half-even')).toBe(2n);
    expect(divideRound(7n, 2n, 'half-even')).toBe(4n);
    expect(divideRound(-5n, 2n, 'half-even')).toBe(-2n);
    expect(divideRound(-7n, 2n, 'half-even')).toBe(-4n);
    expect(divideRound(1n, 2n, 'half-even')).toBe(0n);
    expect(divideRound(3n, 2n, 'half-even')).toBe(2n);
  });

  it("'half-even' still rounds normally away from the midpoint", () => {
    expect(divideRound(8n, 3n, 'half-even')).toBe(3n);
    expect(divideRound(7n, 3n, 'half-even')).toBe(2n);
    expect(divideRound(-8n, 3n, 'half-even')).toBe(-3n);
    expect(divideRound(-7n, 3n, 'half-even')).toBe(-2n);
  });

  it('handles a negative denominator', () => {
    expect(divideRound(7n, -2n, 'half-up')).toBe(-4n);
    expect(divideRound(-7n, -2n, 'half-up')).toBe(4n);
    expect(divideRound(-7n, -2n, 'down')).toBe(3n);
  });

  it('throws on division by zero', () => {
    const error = caught(() => divideRound(1n, 0n, 'half-up'));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error.message).toContain('Division by zero');
  });

  it('stays exact well past the safe integer range', () => {
    expect(divideRound(1000000000000000000000000000000n, 3n, 'down')).toBe(
      333333333333333333333333333333n,
    );
    expect(divideRound(1000000000000000000000000000000n, 3n, 'up')).toBe(
      333333333333333333333333333334n,
    );
  });
});

// ── allocation ─────────────────────────────────────────────────────────────────────────

describe('allocate()', () => {
  it('splits £10.00 across 3 as 3.34 / 3.33 / 3.33', () => {
    const parts = allocate(money(1000, 'GBP'), 3);
    expect(minorUnits(parts)).toEqual([334, 333, 333]);
    expect(totalMinor(parts)).toBe(1000);
    expect(parts.every((part) => part.currency === 'GBP')).toBe(true);
  });

  it('gives the whole amount back for a single part', () => {
    expect(minorUnits(allocate(money(1000, 'GBP'), 1))).toEqual([1000]);
  });

  it('splits evenly when it divides', () => {
    expect(minorUnits(allocate(money(1000, 'USD'), 4))).toEqual([250, 250, 250, 250]);
    expect(minorUnits(allocate(zero('USD'), 3))).toEqual([0, 0, 0]);
  });

  it('preserves the sign on negative amounts and still sums exactly', () => {
    const parts = allocate(money(-1000, 'GBP'), 3);
    expect(minorUnits(parts)).toEqual([-334, -333, -333]);
    expect(totalMinor(parts)).toBe(-1000);
  });

  it('hands out several leftover units one at a time, earliest first', () => {
    expect(minorUnits(allocate(money(10, 'USD'), 4))).toEqual([3, 3, 2, 2]);
    expect(minorUnits(allocate(money(7, 'JPY'), 3))).toEqual([3, 2, 2]);
  });

  it('rejects a non-positive or non-integer count', () => {
    const error = caught(() => allocate(money(1000, 'USD'), 0));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error.message).toContain('positive integer count');
    expect(() => allocate(money(1000, 'USD'), -1)).toThrow(InvalidArgumentError);
    expect(() => allocate(money(1000, 'USD'), 2.5)).toThrow(InvalidArgumentError);
    expect(() => allocate(money(1000, 'USD'), Number.NaN)).toThrow(InvalidArgumentError);
  });
});

describe('allocateByWeights()', () => {
  it('splits proportionally and preserves the exact total', () => {
    const parts = allocateByWeights(money(1000, 'USD'), [1, 2]);
    expect(minorUnits(parts)).toEqual([333, 667]);
    expect(totalMinor(parts)).toBe(1000);
  });

  it('gives the remainder to the largest weight first', () => {
    const parts = allocateByWeights(money(100, 'USD'), [1, 5, 3]);
    expect(minorUnits(parts)).toEqual([11, 56, 33]);
    expect(totalMinor(parts)).toBe(100);
  });

  it('breaks ties by original position', () => {
    const parts = allocateByWeights(money(1001, 'USD'), [2, 2, 1]);
    expect(minorUnits(parts)).toEqual([401, 400, 200]);
    expect(totalMinor(parts)).toBe(1001);
  });

  it('allows zero weights among positive ones', () => {
    const parts = allocateByWeights(money(1000, 'USD'), [0, 1, 1]);
    expect(minorUnits(parts)).toEqual([0, 500, 500]);
  });

  it('preserves the sign of a negative amount', () => {
    const parts = allocateByWeights(money(-100, 'USD'), [1, 5, 3]);
    expect(minorUnits(parts)).toEqual([-11, -56, -33]);
    expect(totalMinor(parts)).toBe(-100);
  });

  it('respects zero-exponent currencies', () => {
    const parts = allocateByWeights(money(100, 'JPY'), [1, 1, 1]);
    expect(minorUnits(parts)).toEqual([34, 33, 33]);
    expect(totalMinor(parts)).toBe(100);
  });

  it('throws when there are no weights', () => {
    const error = caught(() => allocateByWeights(money(1000, 'USD'), []));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error.message).toContain('at least one weight');
  });

  it('throws when the weights sum to zero', () => {
    const error = caught(() => allocateByWeights(money(1000, 'USD'), [0, 0]));
    expect(error.message).toContain('must not sum to zero');
  });

  it('throws on negative or non-integer weights', () => {
    const error = caught(() => allocateByWeights(money(1000, 'USD'), [1, -1]));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error.message).toContain('non-negative integers');
    expect(() => allocateByWeights(money(1000, 'USD'), [1.5, 1])).toThrow(InvalidArgumentError);
    expect(() => allocateByWeights(money(1000, 'USD'), [Number.NaN])).toThrow(InvalidArgumentError);
  });
});

// ── sum ────────────────────────────────────────────────────────────────────────────────

describe('sum()', () => {
  it('totals a single-currency list', () => {
    const total = sum([money(1299, 'USD'), money(999, 'USD'), money(-300, 'USD')]);
    expect(total).toEqual({ amountMinor: 1998, currency: 'USD' });
  });

  it('infers the currency from the first element', () => {
    expect(sum([money(1, 'JPY')]).currency).toBe('JPY');
  });

  it('accepts an explicit currency that matches', () => {
    expect(sum([money(100, 'USD'), money(50, 'USD')], 'usd').amountMinor).toBe(150);
  });

  it('throws on an empty list with no currency', () => {
    const error = caught(() => sum([]));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error.message).toContain('empty list needs an explicit currency');
  });

  it('returns zero for an empty list with a currency', () => {
    expect(sum([], 'USD')).toEqual({ amountMinor: 0, currency: 'USD' });
    expect(sum([], 'jpy')).toEqual({ amountMinor: 0, currency: 'JPY' });
  });

  it('throws on mixed currencies', () => {
    expect(() => sum([money(100, 'USD'), money(100, 'EUR')])).toThrow(CurrencyMismatchError);
  });

  it('throws when the explicit currency disagrees with the items', () => {
    expect(() => sum([money(100, 'USD')], 'EUR')).toThrow(CurrencyMismatchError);
  });

  it('rejects a sparse array', () => {
    const sparse = new Array<Money>(2);
    const error = caught(() => sum(sparse));
    expect(error.message).toContain('sparse array');
  });

  it('adds exact decimals without float drift', () => {
    const tenth = parseMoney('0.1', 'USD');
    const total = sum(new Array<Money>(10).fill(tenth));
    expect(total.amountMinor).toBe(100);
    expect(toDecimalString(total)).toBe('1.00');
  });
});

// ── comparison ─────────────────────────────────────────────────────────────────────────

describe('comparison helpers', () => {
  it('compares within a currency', () => {
    expect(compare(money(1, 'USD'), money(2, 'USD'))).toBe(-1);
    expect(compare(money(2, 'USD'), money(1, 'USD'))).toBe(1);
    expect(compare(money(2, 'USD'), money(2, 'USD'))).toBe(0);
    expect(compare(money(-5, 'USD'), money(0, 'USD'))).toBe(-1);
  });

  it('refuses to compare across currencies', () => {
    expect(() => compare(money(1, 'USD'), money(1, 'EUR'))).toThrow(CurrencyMismatchError);
    expect(() => max(money(1, 'USD'), money(1, 'EUR'))).toThrow(CurrencyMismatchError);
    expect(() => min(money(1, 'USD'), money(1, 'EUR'))).toThrow(CurrencyMismatchError);
  });

  it('equals compares amount and currency without throwing', () => {
    expect(equals(money(100, 'USD'), money(100, 'USD'))).toBe(true);
    expect(equals(money(100, 'USD'), money(100, 'EUR'))).toBe(false);
    expect(equals(money(100, 'USD'), money(101, 'USD'))).toBe(false);
  });

  it('classifies sign', () => {
    expect(isZero(zero('USD'))).toBe(true);
    expect(isZero(money(1, 'USD'))).toBe(false);
    expect(isNegative(money(-1, 'USD'))).toBe(true);
    expect(isNegative(zero('USD'))).toBe(false);
    expect(isPositive(money(1, 'USD'))).toBe(true);
    expect(isPositive(zero('USD'))).toBe(false);
    expect(isPositive(money(-1, 'USD'))).toBe(false);
  });

  it('picks max and min, favouring the first argument on a tie', () => {
    const low = money(1, 'USD');
    const high = money(2, 'USD');
    const tie = money(1, 'USD');
    expect(max(low, high)).toBe(high);
    expect(max(high, low)).toBe(high);
    expect(min(low, high)).toBe(low);
    expect(min(high, low)).toBe(low);
    expect(max(low, tie)).toBe(low);
    expect(min(low, tie)).toBe(low);
  });
});

// ── relative change ────────────────────────────────────────────────────────────────────

describe('relativeChangeBps()', () => {
  it('reports 9.99 -> 12.99 as +3003 bps', () => {
    expect(relativeChangeBps(money(999, 'USD'), money(1299, 'USD'))).toBe(3003);
  });

  it('reports a decrease as a negative bps count', () => {
    expect(relativeChangeBps(money(1299, 'USD'), money(999, 'USD'))).toBe(-2309);
  });

  it('reports no change as zero', () => {
    expect(relativeChangeBps(money(1299, 'USD'), money(1299, 'USD'))).toBe(0);
  });

  it('reports a doubling as 10000 bps', () => {
    expect(relativeChangeBps(money(500, 'USD'), money(1000, 'USD'))).toBe(10_000);
  });

  it('crosses the 3% detection threshold exactly at 300 bps', () => {
    expect(relativeChangeBps(money(10_000, 'USD'), money(10_300, 'USD'))).toBe(300);
    expect(relativeChangeBps(money(10_000, 'USD'), money(10_299, 'USD'))).toBe(299);
  });

  it('rounds half-up', () => {
    // 1 -> 2 over a baseline of 3: 10000/3 = 3333.33 -> 3333.
    expect(relativeChangeBps(money(3, 'USD'), money(4, 'USD'))).toBe(3333);
    // A baseline of 8 puts the result exactly on .5: 10000*1/8 = 1250 exactly.
    expect(relativeChangeBps(money(8, 'USD'), money(9, 'USD'))).toBe(1250);
    expect(relativeChangeBps(money(16, 'USD'), money(17, 'USD'))).toBe(625);
  });

  it('returns null when the baseline is zero', () => {
    expect(relativeChangeBps(zero('USD'), money(1299, 'USD'))).toBeNull();
    expect(relativeChangeBps(zero('USD'), zero('USD'))).toBeNull();
  });

  it('works from a negative baseline', () => {
    expect(relativeChangeBps(money(-100, 'USD'), money(-50, 'USD'))).toBe(-5000);
  });

  it('throws on a currency mismatch', () => {
    expect(() => relativeChangeBps(money(999, 'USD'), money(1299, 'EUR'))).toThrow(
      CurrencyMismatchError,
    );
  });

  it('always returns an integer', () => {
    const bps = relativeChangeBps(money(997, 'USD'), money(1301, 'USD'));
    expect(bps).not.toBeNull();
    expect(Number.isInteger(bps)).toBe(true);
  });
});

describe('bpsToPercentString()', () => {
  it('renders two fraction digits by default', () => {
    expect(bpsToPercentString(3003)).toBe('30.03%');
    expect(bpsToPercentString(300)).toBe('3.00%');
    expect(bpsToPercentString(0)).toBe('0.00%');
    expect(bpsToPercentString(5)).toBe('0.05%');
  });

  it('drops the fraction at fractionDigits 0', () => {
    expect(bpsToPercentString(3003, 0)).toBe('30%');
    expect(bpsToPercentString(299, 0)).toBe('2%');
    expect(bpsToPercentString(0, 0)).toBe('0%');
  });

  it('renders negatives with a leading minus', () => {
    expect(bpsToPercentString(-2309)).toBe('-23.09%');
    expect(bpsToPercentString(-2309, 0)).toBe('-23%');
    expect(bpsToPercentString(-50)).toBe('-0.50%');
    expect(bpsToPercentString(-5, 0)).toBe('-0%');
  });

  it('QUIRK: any non-zero fractionDigits still renders exactly two digits', () => {
    expect(bpsToPercentString(3003, 1)).toBe('30.03%');
    expect(bpsToPercentString(3003, 4)).toBe('30.03%');
  });
});

// ── formatting ─────────────────────────────────────────────────────────────────────────

describe('formatMoney()', () => {
  it('defaults to an en-US symbol format', () => {
    expect(formatMoney(money(1299, 'USD'))).toBe('$12.99');
    expect(formatMoney(money(-500, 'USD'))).toBe('-$5.00');
    expect(formatMoney(money(123456, 'USD'))).toBe('$1,234.56');
  });

  it("renders display: 'code'", () => {
    expect(normaliseSpaces(formatMoney(money(1299, 'USD'), { display: 'code' }))).toBe('USD 12.99');
  });

  it("renders display: 'none'", () => {
    expect(formatMoney(money(1299, 'USD'), { display: 'none' })).toBe('12.99');
    expect(formatMoney(money(123456, 'USD'), { display: 'none' })).toBe('1,234.56');
  });

  it('drops minor units when compact', () => {
    expect(formatMoney(money(1299, 'USD'), { compact: true })).toBe('$13');
    expect(formatMoney(money(1201, 'USD'), { compact: true })).toBe('$12');
    expect(formatMoney(money(1234, 'KWD'), { compact: true, display: 'none' })).toBe('1');
  });

  it('honours signDisplay', () => {
    expect(formatMoney(money(1299, 'USD'), { signDisplay: 'always' })).toBe('+$12.99');
    expect(formatMoney(money(-1299, 'USD'), { signDisplay: 'never' })).toBe('$12.99');
    expect(formatMoney(zero('USD'), { signDisplay: 'exceptZero' })).toBe('$0.00');
    expect(formatMoney(money(1299, 'USD'), { signDisplay: 'exceptZero' })).toBe('+$12.99');
    expect(formatMoney(money(1299, 'USD'), { signDisplay: 'auto' })).toBe('$12.99');
  });

  it('formats a zero-exponent currency without decimals', () => {
    expect(formatMoney(money(1000, 'JPY'))).toBe('¥1,000');
    expect(formatMoney(money(1000, 'JPY'), { compact: true })).toBe('¥1,000');
    expect(formatMoney(money(1000, 'JPY'), { display: 'none' })).toBe('1,000');
  });

  it('formats a three-exponent currency with three decimals', () => {
    expect(normaliseSpaces(formatMoney(money(1234, 'KWD')))).toBe('KWD 1.234');
    expect(formatMoney(money(1234, 'KWD'), { display: 'none' })).toBe('1.234');
  });

  it('varies with the locale', () => {
    expect(normaliseSpaces(formatMoney(money(123456, 'EUR'), { locale: 'de-DE' }))).toBe(
      '1.234,56 €',
    );
    expect(formatMoney(money(1000, 'GBP'), { locale: 'en-GB' })).toBe('£10.00');
    expect(
      normaliseSpaces(formatMoney(money(123456, 'EUR'), { locale: 'fr-FR', display: 'code' })),
    ).toBe('1 234,56 EUR');
  });

  it('combines options', () => {
    expect(
      normaliseSpaces(
        formatMoney(money(-123456, 'USD'), {
          locale: 'en-US',
          display: 'code',
          compact: true,
          signDisplay: 'never',
        }),
      ),
    ).toBe('USD 1,235');
  });
});

describe('toMajorNumber()', () => {
  it('divides by the minor units per major', () => {
    expect(toMajorNumber(money(1299, 'USD'))).toBe(12.99);
    expect(toMajorNumber(money(1000, 'JPY'))).toBe(1000);
    expect(toMajorNumber(money(1234, 'KWD'))).toBe(1.234);
    expect(toMajorNumber(money(-1299, 'USD'))).toBe(-12.99);
    expect(toMajorNumber(zero('USD'))).toBe(0);
  });

  it('is the only float in the module, and it is display-only', () => {
    const value = money(1299, 'USD');
    expect(Number.isInteger(toMajorNumber(value))).toBe(false);
    expect(Number.isInteger(value.amountMinor)).toBe(true);
  });
});

describe('toDecimalString()', () => {
  it('renders exact decimals with no locale', () => {
    expect(toDecimalString(money(1299, 'USD'))).toBe('12.99');
    expect(toDecimalString(money(-1299, 'USD'))).toBe('-12.99');
    expect(toDecimalString(money(5, 'USD'))).toBe('0.05');
    expect(toDecimalString(money(50, 'USD'))).toBe('0.50');
    expect(toDecimalString(zero('USD'))).toBe('0.00');
    expect(toDecimalString(money(123456789, 'USD'))).toBe('1234567.89');
  });

  it('omits the decimal point for a zero-exponent currency', () => {
    expect(toDecimalString(money(1000, 'JPY'))).toBe('1000');
    expect(toDecimalString(money(-1000, 'JPY'))).toBe('-1000');
    expect(toDecimalString(zero('JPY'))).toBe('0');
  });

  it('renders three decimals for a three-exponent currency', () => {
    expect(toDecimalString(money(1234, 'KWD'))).toBe('1.234');
    expect(toDecimalString(money(34, 'KWD'))).toBe('0.034');
    expect(toDecimalString(money(-1234, 'KWD'))).toBe('-1.234');
    expect(toDecimalString(zero('KWD'))).toBe('0.000');
  });

  it('never emits a group separator, so it is safe for CSV and API payloads', () => {
    expect(toDecimalString(money(1234567890, 'USD'))).toBe('12345678.90');
  });
});

// ── property tests ─────────────────────────────────────────────────────────────────────

describe('properties', () => {
  it('parseMoney(toDecimalString(m)) round-trips exactly for any amount and currency', () => {
    fc.assert(
      fc.property(amountArb, currencyArb, (amountMinor, code) => {
        const original = money(amountMinor, code);
        const roundTripped = parseMoney(toDecimalString(original), original.currency);
        expect(roundTripped.amountMinor).toBe(original.amountMinor);
        expect(roundTripped.currency).toBe(original.currency);
        expect(Number.isInteger(roundTripped.amountMinor)).toBe(true);
      }),
    );
  });

  it('allocate() parts always sum back to the original amount', () => {
    fc.assert(
      fc.property(amountArb, fc.integer({ min: 1, max: 50 }), currencyArb, (amountMinor, count, code) => {
        const original = money(amountMinor, code);
        const parts = allocate(original, count);
        expect(parts).toHaveLength(count);
        expect(totalMinor(parts)).toBe(original.amountMinor);
        for (const part of parts) {
          expect(part.currency).toBe(original.currency);
          expect(Number.isInteger(part.amountMinor)).toBe(true);
          if (original.amountMinor >= 0) expect(part.amountMinor).toBeGreaterThanOrEqual(0);
          else expect(part.amountMinor).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it('allocate() parts never differ from each other by more than one minor unit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 50 }),
        (amountMinor, count) => {
          const parts = minorUnits(allocate(money(amountMinor, 'USD'), count));
          expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it('allocateByWeights() preserves the exact total for any positive weights', () => {
    fc.assert(
      fc.property(
        amountArb,
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 12 }),
        currencyArb,
        (amountMinor, weights, code) => {
          fc.pre(weights.reduce((acc, weight) => acc + weight, 0) > 0);
          const original = money(amountMinor, code);
          const parts = allocateByWeights(original, weights);
          expect(parts).toHaveLength(weights.length);
          expect(totalMinor(parts)).toBe(original.amountMinor);
        },
      ),
    );
  });

  it('sum() equals the naive integer sum for a single currency', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }), { maxLength: 25 }),
        currencyArb,
        (amounts, code) => {
          const total = sum(
            amounts.map((amountMinor) => money(amountMinor, code)),
            code,
          );
          const naive = amounts.reduce((acc, amountMinor) => acc + amountMinor, 0);
          expect(total.amountMinor).toBe(naive);
          expect(total.currency).toBe(currency(code));
        },
      ),
    );
  });

  it('add and subtract are inverses', () => {
    fc.assert(
      fc.property(amountArb, amountArb, currencyArb, (left, right, code) => {
        const a = money(left, code);
        const b = money(right, code);
        expect(subtract(add(a, b), b)).toEqual(a);
        expect(add(subtract(a, b), b)).toEqual(a);
        expect(add(a, negate(a)).amountMinor).toBe(0);
      }),
    );
  });

  it('add is commutative and associative over minor units', () => {
    fc.assert(
      fc.property(amountArb, amountArb, amountArb, currencyArb, (left, mid, right, code) => {
        const a = money(left, code);
        const b = money(mid, code);
        const c = money(right, code);
        expect(add(a, b)).toEqual(add(b, a));
        expect(add(add(a, b), c)).toEqual(add(a, add(b, c)));
        expect(add(a, zero(code))).toEqual(a);
      }),
    );
  });

  it('no operation ever produces a fractional amount', () => {
    fc.assert(
      fc.property(
        amountArb,
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.constantFrom<RoundingMode>(...ROUNDING_MODES),
        currencyArb,
        (amountMinor, numerator, denominator, mode, code) => {
          const value = money(amountMinor, code);
          const results = [
            negate(value),
            abs(value),
            multiply(value, 3),
            scale(value, numerator, denominator, mode),
            add(value, value),
            subtract(value, value),
          ];
          for (const result of results) {
            expect(Number.isInteger(result.amountMinor)).toBe(true);
          }
        },
      ),
    );
  });

  it('divideRound never differs from truncation by more than one', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1000000000000000000n, max: 1000000000000000000n }),
        fc.bigInt({ min: 1n, max: 1000000000n }),
        fc.constantFrom<RoundingMode>(...ROUNDING_MODES),
        (numerator, denominator, mode) => {
          const rounded = divideRound(numerator, denominator, mode);
          const truncated = numerator / denominator;
          const difference = rounded - truncated;
          expect(difference >= -1n && difference <= 1n).toBe(true);
        },
      ),
    );
  });

  it('compare and equals agree with each other', () => {
    fc.assert(
      fc.property(amountArb, amountArb, currencyArb, (left, right, code) => {
        const a = money(left, code);
        const b = money(right, code);
        expect(equals(a, b)).toBe(compare(a, b) === 0);
        // Written as a sum rather than a negation so the 0 case does not compare against -0.
        expect(compare(a, b) + compare(b, a)).toBe(0);
        expect(max(a, b).amountMinor).toBe(Math.max(a.amountMinor, b.amountMinor));
        expect(min(a, b).amountMinor).toBe(Math.min(a.amountMinor, b.amountMinor));
      }),
    );
  });
});
