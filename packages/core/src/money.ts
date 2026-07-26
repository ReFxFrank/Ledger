/**
 * Money.
 *
 * Brief §11: "Assert no float arithmetic ever touches a monetary value."
 *
 * So: money is an integer count of minor units plus a currency. Every operation in this file
 * is integer arithmetic. Anything that cannot be expressed as integer arithmetic — dividing by
 * three, applying an FX rate — routes through `bigint` and rounds explicitly, and the rounding
 * mode is a parameter rather than an accident of IEEE-754.
 *
 * `Money` is deliberately not a class. It crosses the tRPC boundary, gets stored in Postgres as
 * two columns, and ends up in a React prop; a plain readonly object survives all three.
 */

import { type CurrencyCode, currency, minorUnitsPerMajor, minorUnitExponent } from './currency';
import { CurrencyMismatchError, InvalidArgumentError, LedgerError } from './errors';

export interface Money {
  /** Signed integer count of minor units. Negative means money coming back (a refund). */
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

/**
 * Beyond this, integer arithmetic on `number` stops being exact. A single subscription charge
 * will never approach it; a naive sum over a hostile dataset could, and silently producing a
 * wrong total is the one thing this module exists to prevent.
 */
const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER;

export type RoundingMode = 'half-up' | 'half-even' | 'down' | 'up';

// ── construction ───────────────────────────────────────────────────────────────────────

export function money(amountMinor: number, code: string | CurrencyCode): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new InvalidArgumentError(
      `Money must be an integer count of minor units, received ${String(amountMinor)}. ` +
        'A fractional value here means a float leaked in upstream.',
    );
  }
  if (!Number.isSafeInteger(amountMinor)) {
    throw new LedgerError('MONEY_OVERFLOW', `Amount ${String(amountMinor)} exceeds safe integer range.`);
  }
  return { amountMinor, currency: currency(code) };
}

export function zero(code: string | CurrencyCode): Money {
  return { amountMinor: 0, currency: currency(code) };
}

/**
 * Parses human input ("12.99", "1,299.00", "€12.99", "12,99") into exact minor units.
 *
 * The decimal string is split on the separator and each side parsed as an integer, so the
 * value never passes through a float. `parseFloat('0.1') * 100` is 10.000000000000002; this
 * is why that global is banned by lint.
 */
export function parseMoney(input: string, code: string | CurrencyCode): Money {
  const target = currency(code);
  const exponent = minorUnitExponent(target);

  const cleaned = input.trim().replace(/[^\d,.\-+]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '+') {
    throw new InvalidArgumentError(`Cannot read an amount from ${JSON.stringify(input)}.`);
  }

  const negative = cleaned.startsWith('-');
  const unsigned = cleaned.replace(/^[+-]/, '');

  // Work out which separator is the decimal point. The last-occurring separator wins, unless
  // it is followed by exactly three digits and there is no other separator — "1,299" is one
  // thousand two hundred and ninety-nine, not 1.299.
  const lastComma = unsigned.lastIndexOf(',');
  const lastDot = unsigned.lastIndexOf('.');
  let decimalIndex = Math.max(lastComma, lastDot);
  if (decimalIndex >= 0) {
    const fractionLength = unsigned.length - decimalIndex - 1;
    const separatorCount = (unsigned.match(/[.,]/g) ?? []).length;
    if (fractionLength === 3 && separatorCount === 1 && exponent !== 3) decimalIndex = -1;
  }

  const wholePart = (decimalIndex >= 0 ? unsigned.slice(0, decimalIndex) : unsigned).replace(/[.,]/g, '');
  const fractionPart = decimalIndex >= 0 ? unsigned.slice(decimalIndex + 1).replace(/[.,]/g, '') : '';

  if (!/^\d*$/.test(wholePart) || !/^\d*$/.test(fractionPart)) {
    throw new InvalidArgumentError(`Cannot read an amount from ${JSON.stringify(input)}.`);
  }

  const paddedFraction = fractionPart.padEnd(exponent, '0').slice(0, exponent);
  const rounded = roundFractionOverflow(fractionPart, exponent);

  const whole = wholePart === '' ? 0n : BigInt(wholePart);
  const fraction = paddedFraction === '' ? 0n : BigInt(paddedFraction);
  const total = whole * BigInt(minorUnitsPerMajor(target)) + fraction + BigInt(rounded);

  const signed = negative ? -total : total;
  return money(toSafeNumber(signed), target);
}

/** "12.996" at exponent 2 rounds the trailing digits into a +1 carry rather than truncating. */
function roundFractionOverflow(fractionPart: string, exponent: number): number {
  if (fractionPart.length <= exponent) return 0;
  const nextDigit = fractionPart[exponent];
  return nextDigit !== undefined && nextDigit >= '5' ? 1 : 0;
}

// ── arithmetic ─────────────────────────────────────────────────────────────────────────

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(checked(a.amountMinor + b.amountMinor), a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(checked(a.amountMinor - b.amountMinor), a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function abs(a: Money): Money {
  return money(Math.abs(a.amountMinor), a.currency);
}

/** Multiplies by an integer factor — "this monthly charge, twelve times". */
export function multiply(a: Money, factor: number): Money {
  if (!Number.isInteger(factor)) {
    throw new InvalidArgumentError(
      `multiply() takes an integer factor; got ${String(factor)}. For a rate, use scale().`,
    );
  }
  return money(checked(a.amountMinor * factor), a.currency);
}

/**
 * Multiplies by a rational factor expressed as numerator/denominator, rounding once at the end.
 *
 * Rates are passed as integers, not as `0.075`, because a rate that arrives as a float has
 * already lost precision before this function can protect anything.
 */
export function scale(
  a: Money,
  numerator: number,
  denominator: number,
  mode: RoundingMode = 'half-up',
): Money {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new InvalidArgumentError('scale() takes integer numerator and denominator.');
  }
  if (denominator === 0) throw new InvalidArgumentError('scale() denominator must not be zero.');
  const result = divideRound(BigInt(a.amountMinor) * BigInt(numerator), BigInt(denominator), mode);
  return money(toSafeNumber(result), a.currency);
}

/** Integer division with an explicit rounding mode. Exported for FX and share allocation. */
export function divideRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new InvalidArgumentError('Division by zero.');

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  if (remainder === 0n) return negative ? -quotient : quotient;

  const twice = remainder * 2n;
  let rounded: bigint;
  switch (mode) {
    case 'down':
      rounded = quotient;
      break;
    case 'up':
      rounded = quotient + 1n;
      break;
    case 'half-up':
      rounded = twice >= absDenominator ? quotient + 1n : quotient;
      break;
    case 'half-even':
      if (twice > absDenominator) rounded = quotient + 1n;
      else if (twice < absDenominator) rounded = quotient;
      else rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
      break;
  }
  return negative ? -rounded : rounded;
}

/**
 * Splits an amount into `count` parts that sum back to exactly the original.
 *
 * Largest-remainder: the leftover minor units are handed out one each to the earliest parts,
 * so £10.00 across 3 people is 3.34 / 3.33 / 3.33 and not 3.33 × 3 with a penny evaporating.
 * Used by subscription shares, where "your cost" must still add up to the actual charge.
 */
export function allocate(a: Money, count: number): Money[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new InvalidArgumentError(`allocate() needs a positive integer count, got ${String(count)}.`);
  }
  return allocateByWeights(a, new Array<number>(count).fill(1));
}

/** Splits proportionally to integer weights, preserving the exact total. */
export function allocateByWeights(a: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) throw new InvalidArgumentError('allocateByWeights() needs at least one weight.');
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) {
    throw new InvalidArgumentError('Weights must be non-negative integers.');
  }
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total === 0) throw new InvalidArgumentError('Weights must not sum to zero.');

  const sign = a.amountMinor < 0 ? -1 : 1;
  const magnitude = Math.abs(a.amountMinor);

  const shares: number[] = [];
  let distributed = 0;
  for (const weight of weights) {
    const share = Math.floor((magnitude * weight) / total);
    shares.push(share);
    distributed += share;
  }

  // Hand the remainder out in weight order, largest first, ties broken by original position.
  let remainder = magnitude - distributed;
  const order = weights
    .map((weight, index) => ({ weight, index }))
    .sort((x, y) => y.weight - x.weight || x.index - y.index);
  for (const { index } of order) {
    if (remainder <= 0) break;
    const current = shares[index];
    if (current === undefined) continue;
    shares[index] = current + 1;
    remainder -= 1;
  }

  return shares.map((share) => money(share * sign, a.currency));
}

/**
 * Sums money of a single currency. Mixed currencies are a hard error — brief §4.4 is explicit
 * that we never sum mixed currencies naively, so the type system and this function both refuse.
 * To total across currencies, convert first (see fx.ts) and then sum.
 */
export function sum(amounts: readonly Money[], code?: string | CurrencyCode): Money {
  if (amounts.length === 0) {
    if (code === undefined) {
      throw new InvalidArgumentError('sum() of an empty list needs an explicit currency.');
    }
    return zero(code);
  }
  const first = amounts[0];
  if (first === undefined) throw new InvalidArgumentError('sum() received a sparse array.');
  const target = code === undefined ? first.currency : currency(code);
  return amounts.reduce<Money>((acc, item) => add(acc, item), zero(target));
}

// ── comparison ─────────────────────────────────────────────────────────────────────────

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0;
}

export function isPositive(a: Money): boolean {
  return a.amountMinor > 0;
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

// ── relative change ────────────────────────────────────────────────────────────────────

/**
 * Relative change in basis points (1bp = 0.01%), as an integer.
 *
 * Price-change detection compares against a 3% threshold (brief §4.4) and the UI shows the
 * delta. Both want a ratio, and a ratio is the one place a float would be tempting — so it is
 * an integer basis-point count instead, computed in bigint. 9.99 → 12.99 is +3003bp.
 * Returns null when the baseline is zero, because the change from nothing is not a percentage.
 */
export function relativeChangeBps(from: Money, to: Money): number | null {
  assertSameCurrency(from, to);
  if (from.amountMinor === 0) return null;
  const delta = BigInt(to.amountMinor - from.amountMinor) * 10_000n;
  return toSafeNumber(divideRound(delta, BigInt(from.amountMinor), 'half-up'));
}

export function bpsToPercentString(bps: number, fractionDigits = 2): string {
  const sign = bps < 0 ? '-' : '';
  const magnitude = Math.abs(bps);
  const whole = Math.floor(magnitude / 100);
  const fraction = String(magnitude % 100).padStart(2, '0');
  return fractionDigits === 0 ? `${sign}${String(whole)}%` : `${sign}${String(whole)}.${fraction}%`;
}

// ── formatting ─────────────────────────────────────────────────────────────────────────

export interface FormatMoneyOptions {
  readonly locale?: string;
  /** 'symbol' → $12.99 · 'code' → USD 12.99 · 'none' → 12.99 */
  readonly display?: 'symbol' | 'code' | 'none';
  /** Drop the minor units entirely — for axis labels and dense tables. */
  readonly compact?: boolean;
  readonly signDisplay?: 'auto' | 'never' | 'always' | 'exceptZero';
}

/**
 * Formats for display only. The value handed to Intl is derived by integer division and
 * string assembly, so the float only ever exists inside the formatter, never in our arithmetic.
 */
export function formatMoney(value: Money, options: FormatMoneyOptions = {}): string {
  const { locale = 'en-US', display = 'symbol', compact = false, signDisplay = 'auto' } = options;
  const exponent = minorUnitExponent(value.currency);
  const digits = compact ? 0 : exponent;

  const formatter = new Intl.NumberFormat(locale, {
    style: display === 'none' ? 'decimal' : 'currency',
    currency: value.currency,
    currencyDisplay: display === 'code' ? 'code' : 'symbol',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay,
  });

  return formatter.format(toMajorNumber(value));
}

/**
 * The one sanctioned float in this module, and it is display-only: `Intl.NumberFormat` takes a
 * number. Every currency in the table has an exponent of at most 3, so any amount below roughly
 * nine trillion major units is exactly representable — far past anything a subscription ledger
 * will hold.
 */
export function toMajorNumber(value: Money): number {
  return value.amountMinor / minorUnitsPerMajor(value.currency);
}

/** Exact decimal string, no locale, no rounding. Use for CSV export and API payloads. */
export function toDecimalString(value: Money): string {
  const exponent = minorUnitExponent(value.currency);
  const negative = value.amountMinor < 0;
  const digits = String(Math.abs(value.amountMinor)).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

// ── internals ──────────────────────────────────────────────────────────────────────────

function checked(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new LedgerError('MONEY_OVERFLOW', `Arithmetic produced ${String(value)}, outside safe integer range.`);
  }
  return value;
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(MAX_SAFE_MINOR) || value < BigInt(-MAX_SAFE_MINOR)) {
    throw new LedgerError('MONEY_OVERFLOW', `Result ${value.toString()} exceeds safe integer range.`);
  }
  return Number(value);
}
