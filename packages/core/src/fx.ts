/**
 * Foreign exchange.
 *
 * Brief §4.4: store the FX rate at charge date, aggregate in the user's display currency, never
 * sum mixed currencies naively.
 *
 * A rate like 1.2734 cannot be held as a float without eventually producing a total that is off
 * by a unit in a way nobody can explain. So a rate is an integer numerator over a power-of-ten
 * denominator, the whole conversion happens in `bigint`, and rounding happens exactly once at
 * the end with an explicit mode.
 */

import { type CurrencyCode, currency, minorUnitExponent } from './currency';
import { InvalidArgumentError } from './errors';
import { type Money, type RoundingMode, divideRound, money } from './money';

/** Digits of precision carried by a rate. Nine covers every published FX quote. */
export const FX_SCALE = 9;
const FX_SCALE_FACTOR = 10n ** BigInt(FX_SCALE);

export interface FxRate {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  /** rate × 10^FX_SCALE, as an integer. 1.2734 USD→EUR is 1_273_400_000. */
  readonly scaledRate: bigint;
  /** The date the rate applies to, `YYYY-MM-DD`. Rates are point-in-time facts. */
  readonly asOf: string;
}

/**
 * Builds a rate from a decimal string. A string, not a number, so the caller cannot hand us a
 * value that has already lost precision on its way in from JSON.
 */
export function fxRate(from: string, to: string, rate: string, asOf: string): FxRate {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (match === null) {
    throw new InvalidArgumentError(`FX rate must be a positive decimal string, got ${JSON.stringify(rate)}.`);
  }
  const [, whole = '0', fraction = ''] = match;
  if (fraction.length > FX_SCALE) {
    throw new InvalidArgumentError(`FX rate carries more than ${String(FX_SCALE)} decimal places.`);
  }
  const scaled = BigInt(whole) * FX_SCALE_FACTOR + BigInt((fraction || '0').padEnd(FX_SCALE, '0'));
  if (scaled === 0n) throw new InvalidArgumentError('FX rate must be greater than zero.');

  return { from: currency(from), to: currency(to), scaledRate: scaled, asOf };
}

/** Inverts a rate. Reciprocal of an integer ratio, rounded half-even to stay symmetric. */
export function invertRate(rate: FxRate): FxRate {
  return {
    from: rate.to,
    to: rate.from,
    scaledRate: divideRound(FX_SCALE_FACTOR * FX_SCALE_FACTOR, rate.scaledRate, 'half-even'),
    asOf: rate.asOf,
  };
}

export function identityRate(code: string, asOf: string): FxRate {
  const target = currency(code);
  return { from: target, to: target, scaledRate: FX_SCALE_FACTOR, asOf };
}

/**
 * Converts, accounting for both the rate and the difference in minor-unit exponents.
 *
 * ¥1000 (exponent 0) to USD (exponent 2) is not "1000 × rate" — the minor units mean different
 * things on each side. Getting this wrong is a factor-of-100 error, which is the kind that
 * makes a user think their subscriptions cost more than their rent.
 */
export function convert(amount: Money, rate: FxRate, mode: RoundingMode = 'half-up'): Money {
  if (amount.currency !== rate.from) {
    throw new InvalidArgumentError(
      `Rate converts ${rate.from}→${rate.to} but the amount is ${amount.currency}.`,
    );
  }
  if (rate.from === rate.to) return amount;

  const exponentDelta = minorUnitExponent(rate.to) - minorUnitExponent(rate.from);

  let numerator = BigInt(amount.amountMinor) * rate.scaledRate;
  let denominator = FX_SCALE_FACTOR;
  if (exponentDelta > 0) numerator *= 10n ** BigInt(exponentDelta);
  else if (exponentDelta < 0) denominator *= 10n ** BigInt(-exponentDelta);

  return money(Number(divideRound(numerator, denominator, mode)), rate.to);
}

/** Looks up a rate for a pair, accepting either direction and the identity case. */
export interface RateTable {
  find(from: CurrencyCode, to: CurrencyCode, asOf: string): FxRate | null;
}

export function staticRateTable(rates: readonly FxRate[]): RateTable {
  return {
    find(from, to) {
      if (from === to) return identityRate(from, '');
      const direct = rates.find((r) => r.from === from && r.to === to);
      if (direct !== undefined) return direct;
      const inverse = rates.find((r) => r.from === to && r.to === from);
      return inverse === undefined ? null : invertRate(inverse);
    },
  };
}

/**
 * Sums amounts in mixed currencies into one display currency.
 *
 * Anything with no available rate is returned in `unconvertible` rather than dropped or
 * coerced. A total that quietly omits a subscription is worse than a total that says so.
 */
export function sumConverted(
  amounts: readonly Money[],
  target: string | CurrencyCode,
  table: RateTable,
  asOf: string,
): { total: Money; unconvertible: Money[] } {
  const targetCurrency = currency(target);
  const unconvertible: Money[] = [];
  let totalMinor = 0;

  for (const amount of amounts) {
    if (amount.currency === targetCurrency) {
      totalMinor += amount.amountMinor;
      continue;
    }
    const rate = table.find(amount.currency, targetCurrency, asOf);
    if (rate === null) {
      unconvertible.push(amount);
      continue;
    }
    totalMinor += convert(amount, rate).amountMinor;
  }

  return { total: money(totalMinor, targetCurrency), unconvertible };
}
