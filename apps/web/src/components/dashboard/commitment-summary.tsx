'use client';

import * as React from 'react';
import Link from 'next/link';
import { Money, cn } from '@ledger/ui';

/**
 * The totals, deliberately quiet.
 *
 * They sit under the horizon and they stay under it. Brief §6.1 makes the timeline the hero, and
 * a row of big number-cards competing with it turns the page back into the generic fintech
 * dashboard this product is explicitly not.
 *
 * The two footnote lines are the important part of this component. `aggregateCommitments`
 * reports which rows it converted at the static fallback rate and which it could not convert at
 * all, and a UI that drops either on the floor turns a labelled approximation into a claimed
 * fact — which is the one failure mode the money layer exists to prevent.
 */

export interface CommitmentSummaryProps {
  readonly monthlyMinor: number;
  readonly annualMinor: number;
  readonly currency: string;
  readonly count: number;
  readonly unconvertibleIds: readonly string[];
  /** Rows converted at the static fallback rate — in the totals, but approximately. */
  readonly approximateIds: readonly string[];
  /** The date the fallback rate snapshot was taken, `YYYY-MM-DD`. */
  readonly approximateRateDate: string;
  readonly locale?: string;
  readonly className?: string;
}

export function CommitmentSummary({
  monthlyMinor,
  annualMinor,
  currency,
  count,
  unconvertibleIds,
  approximateIds,
  approximateRateDate,
  locale,
  className,
}: CommitmentSummaryProps): React.ReactNode {
  const excluded = unconvertibleIds.length;
  const approximate = approximateIds.length;

  return (
    <div className={cn('flex flex-col gap-[var(--gap)]', className)}>
      <div className="grid gap-[var(--gap)] sm:grid-cols-3">
        <Figure label="Monthly commitment">
          <Money
            amountMinor={monthlyMinor}
            currency={currency}
            tone="outflow"
            size="xl"
            {...(locale === undefined ? {} : { locale })}
          />
        </Figure>
        <Figure label="Annualized">
          <Money
            amountMinor={annualMinor}
            currency={currency}
            tone="outflow"
            size="xl"
            {...(locale === undefined ? {} : { locale })}
          />
        </Figure>
        <Figure label="Subscriptions">
          <span className="font-mono text-2xl font-medium tracking-tight tabular-nums text-text">
            {count}
          </span>
        </Figure>
      </div>

      {approximate > 0 ? (
        <p className="text-xs text-text-2">
          {approximate === 1
            ? '1 subscription is billed in another currency and is'
            : `${String(approximate)} subscriptions are billed in another currency and are`}{' '}
          converted at an indicative rate from {approximateRateDate}, so these totals are
          approximate.
        </p>
      ) : null}

      {excluded > 0 ? (
        <p className="text-xs text-text-2">
          {excluded === 1
            ? '1 subscription is not in these totals'
            : `${String(excluded)} subscriptions are not in these totals`}{' '}
          — they are billed in a currency we have no exchange rate for, and a converted figure
          would be a guess.{' '}
          <Link
            href="/subscriptions"
            className="text-control-2 underline underline-offset-2 hover:text-control"
          >
            See which ones
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function Figure({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.ReactNode {
  return (
    <div className="rounded-md border border-line bg-ink-700 p-[var(--pad-card)] shadow-card">
      <p className="eyebrow">{label}</p>
      <p className="mt-2">{children}</p>
    </div>
  );
}
