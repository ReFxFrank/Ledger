/**
 * Formatting shared by the analytics charts.
 *
 * Every figure on the screen goes through `formatMoney` in @ledger/core, including the ones drawn
 * as axis labels — an axis that rounds differently from the table under it is an axis that makes
 * the table look wrong.
 */

import { formatMoney, money } from '@ledger/core';

/** An amount, or an em dash when the row carries something that is not a valid amount. */
export function formatMinor(
  amountMinor: number,
  currency: string,
  locale: string,
  compact = false,
): string {
  if (!Number.isSafeInteger(amountMinor)) return '—';
  try {
    return formatMoney(money(amountMinor, currency), { locale, compact });
  } catch {
    return '—';
  }
}

const monthFormatters = new Map<string, Intl.DateTimeFormat>();

/** "2026-08" → "Aug 2026". Formatted in UTC so the label cannot slip a month at a zone boundary. */
export function formatMonthKey(key: string, locale: string): string {
  const cached = monthFormatters.get(locale);
  const formatter =
    cached ??
    new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (cached === undefined) monthFormatters.set(locale, formatter);

  const [year, month] = key.split('-');
  const yearNumber = Number.parseInt(year ?? '', 10);
  const monthNumber = Number.parseInt(month ?? '', 10);
  if (!Number.isInteger(yearNumber) || !Number.isInteger(monthNumber)) return key;
  return formatter.format(new Date(Date.UTC(yearNumber, monthNumber - 1, 1)));
}

/** "Aug" alone, for a crowded axis where the year is already in the caption. */
export function formatMonthShort(key: string, locale: string): string {
  return formatMonthKey(key, locale).split(' ')[0] ?? key;
}

/**
 * Which currency to draw.
 *
 * There is no FX rate table yet (see the TODO in routers/dashboard.ts), so mixing currencies in
 * one total is forbidden — a converted figure invented here would be a wrong number wearing a
 * right number's clothes. The chart draws one currency and names the ones it left out, which is
 * the honest version of the same screen.
 */
export function chooseCurrency(
  rows: readonly { readonly currency: string; readonly totalMinor: number }[],
  preferred: string,
): { readonly currency: string | null; readonly excluded: readonly string[] } {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + Math.abs(row.totalMinor));
  }
  if (totals.size === 0) return { currency: null, excluded: [] };

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const chosen = totals.has(preferred) ? preferred : (ranked[0]?.[0] ?? null);
  return {
    currency: chosen,
    excluded: ranked.map(([code]) => code).filter((code) => code !== chosen),
  };
}
