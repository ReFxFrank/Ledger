/**
 * ISO-4217 currencies and their minor-unit exponents.
 *
 * The exponent is the reason this table exists rather than a hardcoded 100 everywhere:
 * JPY has no minor unit, KWD has three. `1000` in JPY is ¥1,000; `1000` in KWD is 1.000 KWD;
 * `1000` in USD is $10.00. Every conversion, sum, and format has to know which.
 */

import { UnsupportedCurrencyError } from './errors';

export interface CurrencyDefinition {
  /** ISO-4217 alphabetic code. */
  readonly code: string;
  /** Number of digits after the decimal separator. */
  readonly exponent: 0 | 2 | 3;
  readonly name: string;
}

const DEFINITIONS: readonly CurrencyDefinition[] = [
  { code: 'AED', exponent: 2, name: 'UAE Dirham' },
  { code: 'AUD', exponent: 2, name: 'Australian Dollar' },
  { code: 'BGN', exponent: 2, name: 'Bulgarian Lev' },
  { code: 'BHD', exponent: 3, name: 'Bahraini Dinar' },
  { code: 'BRL', exponent: 2, name: 'Brazilian Real' },
  { code: 'CAD', exponent: 2, name: 'Canadian Dollar' },
  { code: 'CHF', exponent: 2, name: 'Swiss Franc' },
  { code: 'CLP', exponent: 0, name: 'Chilean Peso' },
  { code: 'CNY', exponent: 2, name: 'Yuan Renminbi' },
  { code: 'COP', exponent: 2, name: 'Colombian Peso' },
  { code: 'CZK', exponent: 2, name: 'Czech Koruna' },
  { code: 'DKK', exponent: 2, name: 'Danish Krone' },
  { code: 'EUR', exponent: 2, name: 'Euro' },
  { code: 'GBP', exponent: 2, name: 'Pound Sterling' },
  { code: 'HKD', exponent: 2, name: 'Hong Kong Dollar' },
  { code: 'HUF', exponent: 2, name: 'Forint' },
  { code: 'IDR', exponent: 2, name: 'Rupiah' },
  { code: 'ILS', exponent: 2, name: 'New Israeli Sheqel' },
  { code: 'INR', exponent: 2, name: 'Indian Rupee' },
  { code: 'ISK', exponent: 0, name: 'Iceland Krona' },
  { code: 'JOD', exponent: 3, name: 'Jordanian Dinar' },
  { code: 'JPY', exponent: 0, name: 'Yen' },
  { code: 'KRW', exponent: 0, name: 'Won' },
  { code: 'KWD', exponent: 3, name: 'Kuwaiti Dinar' },
  { code: 'MXN', exponent: 2, name: 'Mexican Peso' },
  { code: 'MYR', exponent: 2, name: 'Malaysian Ringgit' },
  { code: 'NOK', exponent: 2, name: 'Norwegian Krone' },
  { code: 'NZD', exponent: 2, name: 'New Zealand Dollar' },
  { code: 'OMR', exponent: 3, name: 'Rial Omani' },
  { code: 'PHP', exponent: 2, name: 'Philippine Peso' },
  { code: 'PLN', exponent: 2, name: 'Zloty' },
  { code: 'RON', exponent: 2, name: 'Romanian Leu' },
  { code: 'SAR', exponent: 2, name: 'Saudi Riyal' },
  { code: 'SEK', exponent: 2, name: 'Swedish Krona' },
  { code: 'SGD', exponent: 2, name: 'Singapore Dollar' },
  { code: 'THB', exponent: 2, name: 'Baht' },
  { code: 'TRY', exponent: 2, name: 'Turkish Lira' },
  { code: 'TWD', exponent: 2, name: 'New Taiwan Dollar' },
  { code: 'TND', exponent: 3, name: 'Tunisian Dinar' },
  { code: 'UAH', exponent: 2, name: 'Hryvnia' },
  { code: 'USD', exponent: 2, name: 'US Dollar' },
  { code: 'VND', exponent: 0, name: 'Dong' },
  { code: 'ZAR', exponent: 2, name: 'Rand' },
];

const BY_CODE = new Map<string, CurrencyDefinition>(DEFINITIONS.map((d) => [d.code, d]));

export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

export function isCurrencyCode(value: string): boolean {
  return BY_CODE.has(value.toUpperCase());
}

/** Validates and brands a currency code. Throws for anything not in the table. */
export function currency(code: string): CurrencyCode {
  const upper = code.toUpperCase();
  if (!BY_CODE.has(upper)) throw new UnsupportedCurrencyError(code);
  return upper as CurrencyCode;
}

export function currencyDefinition(code: CurrencyCode): CurrencyDefinition {
  const definition = BY_CODE.get(code);
  if (definition === undefined) throw new UnsupportedCurrencyError(code);
  return definition;
}

export function minorUnitExponent(code: CurrencyCode): number {
  return currencyDefinition(code).exponent;
}

/** 10 ** exponent — how many minor units are in one major unit. */
export function minorUnitsPerMajor(code: CurrencyCode): number {
  return 10 ** minorUnitExponent(code);
}

export function allCurrencies(): readonly CurrencyDefinition[] {
  return DEFINITIONS;
}
