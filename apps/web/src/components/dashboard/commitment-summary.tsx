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
 * The unconvertible line is the important part of this component. `aggregateCommitments` returns
 * the ids it could not convert instead of guessing a rate, and a UI that drops them on the floor
 * turns an honest gap into a wrong total — which is the one failure mode the money layer exists
 * to prevent.
 */

export interface CommitmentSummaryProps {
  readonly monthlyMinor: number;
  readonly annualMinor: number;
  readonly currency: string;
  readonly count: number;
  readonly unconvertibleIds: readonly string[];
  readonly locale?: string;
  readonly className?: string;
}

export function CommitmentSummary({
  monthlyMinor,
  annualMinor,
  currency,
  count,
  unconvertibleIds,
  locale,
  className,
}: CommitmentSummaryProps): React.ReactNode {
  const excluded = unconvertibleIds.length;

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
