'use client';

import * as React from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import {
  type FormatMoneyOptions,
  type Money as MoneyValue,
  bpsToPercentString,
  formatMoney,
  money,
  relativeChangeBps,
} from '@ledger/core';
import { Badge } from './badge';
import { cn } from './lib/cn';

/**
 * Money on screen.
 *
 * Every amount in the product goes through here, for two reasons. One: formatting lives in
 * `@ledger/core`, so a figure in a table and the same figure in a chart tooltip cannot disagree.
 * Two: mono with tabular figures is not decoration — a column of prices that does not align is a
 * column nobody scans, and "£9.99 vs £99.90" is a mistake you make in a proportional font.
 *
 * The component never does arithmetic. It takes integer minor units and asks core to render them.
 */

/** Structural shape of an amount, so callers can pass a DB row without constructing a `Money`. */
export interface MoneyLike {
  readonly amountMinor: number;
  readonly currency: string;
}

export type MoneyTone = 'outflow' | 'reclaim' | 'plain';
export type MoneySize = 'sm' | 'md' | 'lg' | 'xl';

const TONE_CLASSES: Readonly<Record<MoneyTone, string>> = {
  // Amber is money leaving. It is the default for a charge, a total, an upcoming renewal.
  outflow: 'text-outflow',
  // Green is money recovered, and the brief reserves it for that counter alone.
  reclaim: 'text-reclaim',
  plain: 'text-text',
};

const SIZE_CLASSES: Readonly<Record<MoneySize, string>> = {
  sm: 'text-xs',
  md: 'text-[0.8125rem]',
  lg: 'text-base font-medium',
  xl: 'text-2xl font-medium tracking-tight',
};

export interface MoneyProps extends Omit<React.ComponentPropsWithoutRef<'span'>, 'children'> {
  readonly amountMinor: number;
  readonly currency: string;
  readonly tone?: MoneyTone;
  readonly size?: MoneySize;
  readonly signDisplay?: NonNullable<FormatMoneyOptions['signDisplay']>;
  /** `symbol` → $12.99 · `code` → USD 12.99 · `none` → 12.99 */
  readonly display?: NonNullable<FormatMoneyOptions['display']>;
  /** Drop the minor units. For axis labels and very dense tables only. */
  readonly compact?: boolean;
  readonly locale?: string;
}

/**
 * Builds a `Money` without letting bad data take the page down.
 *
 * Both failure modes come from outside: a fractional amount means a float leaked in upstream, an
 * unknown currency code means a bank feed sent something not in the ISO table. Neither is worth
 * blanking a dashboard over, so they render as an em dash and stay visible as a bug.
 */
function toMoney(amountMinor: number, code: string): MoneyValue | null {
  if (!Number.isSafeInteger(amountMinor)) return null;
  try {
    return money(amountMinor, code);
  } catch {
    return null;
  }
}

export const Money = React.forwardRef<HTMLSpanElement, MoneyProps>(function Money(
  {
    className,
    amountMinor,
    currency,
    tone = 'plain',
    size = 'md',
    signDisplay = 'auto',
    display = 'symbol',
    compact = false,
    locale,
    ...props
  },
  ref,
) {
  const value = toMoney(amountMinor, currency);
  const classes = cn(
    'font-mono tabular-nums whitespace-nowrap',
    SIZE_CLASSES[size],
    TONE_CLASSES[tone],
    className,
  );

  if (value === null) {
    return (
      <span ref={ref} className={cn(classes, 'text-text-3')} title="Amount unavailable" {...props}>
        —
      </span>
    );
  }

  const options: FormatMoneyOptions = {
    ...(locale === undefined ? {} : { locale }),
    display,
    compact,
    signDisplay,
  };

  return (
    <span ref={ref} className={classes} {...props}>
      {formatMoney(value, options)}
    </span>
  );
});

export interface MoneyDeltaProps extends Omit<React.ComponentPropsWithoutRef<'span'>, 'children'> {
  readonly from: MoneyLike;
  readonly to: MoneyLike;
  readonly size?: MoneySize;
  readonly locale?: string;
  /** Hide the percentage chip when the surrounding row already carries it. */
  readonly showPercent?: boolean;
}

/**
 * A price change: old → new, with the size of the move.
 *
 * The percentage comes from `relativeChangeBps`, which is integer basis points — the same number
 * the detector compares against its 3% threshold, so the UI cannot claim a different figure from
 * the one that raised the alert.
 *
 * Colour: an increase is `--alert`, because a provider raising your price without asking is the
 * problem the product exists to catch. A decrease takes `--reclaim` — the one sanctioned use
 * outside the savings counter, and it is the same idea: money coming back to you.
 */
export const MoneyDelta = React.forwardRef<HTMLSpanElement, MoneyDeltaProps>(function MoneyDelta(
  { className, from, to, size = 'md', locale, showPercent = true, ...props },
  ref,
) {
  // A currency switch is not a percentage. Show both amounts and let the user read the change.
  const comparable = from.currency === to.currency;
  const fromValue = toMoney(from.amountMinor, from.currency);
  const toValue = toMoney(to.amountMinor, to.currency);
  const bps =
    comparable && fromValue !== null && toValue !== null ? relativeChangeBps(fromValue, toValue) : null;

  const increased = to.amountMinor > from.amountMinor;
  const unchanged = comparable && to.amountMinor === from.amountMinor;
  const moveClass = increased ? 'text-alert' : 'text-reclaim';
  const localeProp = locale === undefined ? {} : { locale };

  // Nothing moved: one amount, stated plainly. A "0.00%" chip is noise dressed as information.
  if (unchanged) {
    return (
      <Money
        ref={ref}
        amountMinor={to.amountMinor}
        currency={to.currency}
        size={size}
        tone="plain"
        className={className}
        {...localeProp}
        {...props}
      />
    );
  }

  const Arrow = increased ? ArrowUpRight : ArrowDownRight;

  return (
    <span ref={ref} className={cn('inline-flex flex-wrap items-center gap-1.5', className)} {...props}>
      <span className="sr-only">was </span>
      <Money
        amountMinor={from.amountMinor}
        currency={from.currency}
        size={size}
        tone="plain"
        className="text-text-3 line-through"
        {...localeProp}
      />
      <Arrow className={cn('size-3.5 shrink-0', moveClass)} aria-hidden />
      <span className="sr-only">now </span>
      <Money
        amountMinor={to.amountMinor}
        currency={to.currency}
        size={size}
        tone="plain"
        className={moveClass}
        {...localeProp}
      />
      {showPercent && bps !== null ? (
        <Badge tone={increased ? 'alert' : 'reclaim'} mono>
          {bps > 0 ? '+' : ''}
          {bpsToPercentString(bps)}
        </Badge>
      ) : null}
    </span>
  );
});
