/**
 * Display formatting for templates.
 *
 * Nothing here computes a monetary value — every figure an email states was computed by the
 * scheduler and frozen into the payload. This file only turns already-correct values into
 * already-correct strings.
 */

import { type Money, type RecurrenceInterval, formatMoney, intervalLabel, parsePlainDate } from '@ledger/core';
import type { IsoDate } from '../types';

/**
 * "3 August 2026".
 *
 * `new Date` appears here with explicit components and is immediately pinned to UTC, so it never
 * reads the clock and never re-interprets the date in the runtime's local zone — the payload's
 * date is already the user's local calendar day, resolved at schedule time.
 */
export function formatDay(iso: IsoDate, locale: string): string {
  const date = parsePlainDate(iso);
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(utc);
}

/** "3 Aug" — for subject lines, where every character counts. */
export function formatDayShort(iso: IsoDate, locale: string): string {
  const date = parsePlainDate(iso);
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(
    utc,
  );
}

export function amount(value: Money, locale: string): string {
  return formatMoney(value, { locale });
}

/** "£12.99 monthly". */
export function amountWithCadence(
  value: Money,
  interval: RecurrenceInterval,
  locale: string,
): string {
  return `${amount(value, locale)} ${intervalLabel(interval).toLowerCase()}`;
}

/** An explicitly signed amount — "+£36.00" — for a change the reader needs to feel the direction of. */
export function signedAmount(value: Money, locale: string): string {
  return formatMoney(value, { locale, signDisplay: 'exceptZero' });
}

/** Basis points as a percentage: 3003 → "+30.03%". */
export function percentFromBps(bps: number): string {
  const sign = bps > 0 ? '+' : bps < 0 ? '-' : '';
  const magnitude = Math.abs(bps);
  const whole = Math.floor(magnitude / 100);
  const fraction = String(magnitude % 100).padStart(2, '0');
  return `${sign}${String(whole)}.${fraction}%`;
}

export function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}
