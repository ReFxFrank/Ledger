/**
 * Presentation helpers shared by the subscription surfaces.
 *
 * Everything here is a thin shell over `@ledger/core`. Two rules it exists to enforce:
 *
 *  1. **No date arithmetic outside `PlainDate`.** A renewal on the 31st is the reason
 *     `plain-date.ts` exists; recreating "add a month" with `Date` in a cell renderer would
 *     reintroduce the exact drift that module was written to remove.
 *  2. **No money arithmetic outside the money helpers.** Every figure below is produced by
 *     `annualEquivalent` / `formatMoney`, both of which are integer-only.
 *
 * `Intl` formatters are cached because a 200-row table asks for one per cell per render, and
 * constructing a `DateTimeFormat` is one of the more expensive things a render can do.
 */

import {
  type Money as MoneyValue,
  type PlainDate,
  type RecurrenceInterval,
  annualEquivalent,
  formatMoney,
  fromInstant,
  monthlyEquivalent,
  money,
  toEpochDay,
} from '@ledger/core';

// ── formatter caches ───────────────────────────────────────────────────────────────────

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const instantFormatters = new Map<string, Intl.DateTimeFormat>();
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();

function dayFormatter(locale: string): Intl.DateTimeFormat {
  const cached = dayFormatters.get(locale);
  if (cached !== undefined) return cached;
  // Formatted in UTC against a UTC-constructed instant, so the calendar date the user asked for
  // is the calendar date they get — no zone shift can move "14 Aug" to "13 Aug" on the way out.
  const created = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  dayFormatters.set(locale, created);
  return created;
}

function instantFormatter(locale: string, timeZone: string): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}`;
  const cached = instantFormatters.get(key);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
  instantFormatters.set(key, created);
  return created;
}

function relativeFormatter(locale: string): Intl.RelativeTimeFormat {
  const cached = relativeFormatters.get(locale);
  if (cached !== undefined) return cached;
  const created = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  relativeFormatters.set(locale, created);
  return created;
}

// ── dates ──────────────────────────────────────────────────────────────────────────────

export function todayIn(timezone: string): PlainDate {
  return fromInstant(new Date(), timezone);
}

/** "14 Aug 2026". The absolute half of every date in the product. */
export function formatDay(date: PlainDate, locale: string): string {
  return dayFormatter(locale).format(new Date(Date.UTC(date.year, date.month - 1, date.day)));
}

/** "14 Aug 2026, 09:31" — for log entries, where the time of day is the point. */
export function formatInstant(value: Date, locale: string, timezone: string): string {
  return instantFormatter(locale, timezone).format(value);
}

/**
 * "in 5 days" / "Today" / "3 months ago".
 *
 * The gap is a difference of epoch days, so it is exact. Only the *bucketing* into months is
 * approximate, and that is a labelling choice — the absolute date sits next to it in every
 * place this is used, so the user never has to infer the real day from the relative phrase.
 */
export function formatRelativeDay(target: PlainDate, today: PlainDate, locale: string): string {
  const days = toEpochDay(target) - toEpochDay(today);
  const formatter = relativeFormatter(locale);
  if (Math.abs(days) < 45) return capitalizeFirst(formatter.format(days, 'day'));
  if (Math.abs(days) < 400) return capitalizeFirst(formatter.format(Math.round(days / 30), 'month'));
  return capitalizeFirst(formatter.format(Math.round(days / 365), 'year'));
}

export function daysUntil(target: PlainDate, today: PlainDate): number {
  return toEpochDay(target) - toEpochDay(today);
}

function capitalizeFirst(value: string): string {
  const first = value.charAt(0);
  return first === '' ? value : `${first.toUpperCase()}${value.slice(1)}`;
}

// ── money ──────────────────────────────────────────────────────────────────────────────

/**
 * Builds a `Money` without letting a bad row take a screen down.
 *
 * Same reasoning as the `Money` component: a fractional amount means a float leaked in
 * upstream and an unknown code means a bank feed sent something outside the ISO table. Both
 * are bugs worth seeing, neither is worth a blank page.
 */
export function safeMoney(amountMinor: number, currency: string): MoneyValue | null {
  if (!Number.isSafeInteger(amountMinor)) return null;
  try {
    return money(amountMinor, currency);
  } catch {
    return null;
  }
}

/** "£119.88/yr" — the annualised figure, rounded once, in integer space. */
export function annualCostLabel(
  amountMinor: number,
  currency: string,
  value: RecurrenceInterval,
  locale: string,
): string | null {
  const amount = safeMoney(amountMinor, currency);
  if (amount === null) return null;
  return `${formatMoney(annualEquivalent(amount, value), { locale })}/yr`;
}

/** "£9.99/mo". Used where a column has to compare cadences against each other. */
export function monthlyCostLabel(
  amountMinor: number,
  currency: string,
  value: RecurrenceInterval,
  locale: string,
): string | null {
  const amount = safeMoney(amountMinor, currency);
  if (amount === null) return null;
  return `${formatMoney(monthlyEquivalent(amount, value), { locale })}/mo`;
}

/**
 * Totals a set of amounts, but only when they all share a currency.
 *
 * There is no FX rate table yet (see the TODO in `routers/dashboard.ts`), and a mixed-currency
 * total computed by ignoring that is a wrong number presented as a fact. Returning null lets
 * the caller say "12 subscriptions" instead of inventing a sum.
 */
export function sumIfSingleCurrency(
  amounts: readonly { readonly amountMinor: number; readonly currency: string }[],
): MoneyValue | null {
  const first = amounts[0];
  if (first === undefined) return null;
  let total = 0;
  for (const item of amounts) {
    if (item.currency !== first.currency) return null;
    total += item.amountMinor;
  }
  return safeMoney(total, first.currency);
}
