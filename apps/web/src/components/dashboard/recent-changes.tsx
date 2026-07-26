'use client';

import * as React from 'react';
import Link from 'next/link';
import { type SubscriptionStatus, intervalLabel, interval } from '@ledger/core';
import { EmptyState, Money, Panel, PanelBody, PanelHeader, StatusPill, Button } from '@ledger/ui';

/**
 * What moved recently.
 *
 * Ordered by `updated_at`, which covers both what the user changed and what a sync changed — the
 * two are indistinguishable to someone trying to answer "why is my total different from last
 * week", and separating them into two lists makes that question harder rather than easier.
 */

export interface RecentChange {
  readonly id: string;
  readonly displayName: string;
  readonly status: SubscriptionStatus;
  readonly amountMinor: number;
  readonly currency: string;
  readonly intervalUnit: 'day' | 'week' | 'month' | 'year';
  readonly intervalCount: number;
  readonly updatedAt: Date;
}

export interface RecentChangesProps {
  readonly items: readonly RecentChange[];
  readonly now: Date;
  readonly locale?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Coarse on purpose: "3 days ago" is the answer; "3 days, 4 hours ago" is noise. */
function since(then: Date, now: Date): string {
  const elapsed = now.getTime() - then.getTime();
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${String(Math.floor(elapsed / MINUTE))}m ago`;
  if (elapsed < DAY) return `${String(Math.floor(elapsed / HOUR))}h ago`;
  const days = Math.floor(elapsed / DAY);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${String(days)}d ago`;
  return `${String(Math.floor(days / 30))}mo ago`;
}

export function RecentChanges({ items, now, locale }: RecentChangesProps): React.ReactNode {
  const localeProp = locale === undefined ? {} : { locale };

  return (
    <Panel>
      <PanelHeader
        eyebrow="Recent changes"
        actions={
          items.length > 0 ? (
            <Button asChild size="sm" variant="ghost">
              <Link href="/subscriptions">See all</Link>
            </Button>
          ) : null
        }
      />
      {items.length === 0 ? (
        <EmptyState
          actions={
            <Button asChild size="sm" variant="primary">
              <Link href="/subscriptions">Add a subscription</Link>
            </Button>
          }
        >
          Add the first subscription and every edit to it shows up here.
        </EmptyState>
      ) : (
        <PanelBody className="p-[var(--gap-tight)]">
          <ul className="flex flex-col">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/subscriptions/${item.id}`}
                  className="flex items-center justify-between gap-[var(--gap)] rounded-md px-[var(--gap-loose)] py-2.5 transition-[background-color] duration-[var(--duration-fast)] ease-standard hover:bg-ink-700"
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-[var(--gap-tight)]">
                      <span className="truncate text-sm leading-tight text-text">
                        {item.displayName}
                      </span>
                      <StatusPill status={item.status} dot={false} />
                    </span>
                    <span className="text-xs leading-tight text-text-3">
                      {intervalLabel(interval(item.intervalUnit, item.intervalCount))} ·{' '}
                      {since(item.updatedAt, now)}
                    </span>
                  </span>
                  <Money
                    amountMinor={item.amountMinor}
                    currency={item.currency}
                    tone="outflow"
                    size="md"
                    {...localeProp}
                  />
                </Link>
              </li>
            ))}
          </ul>
        </PanelBody>
      )}
    </Panel>
  );
}
