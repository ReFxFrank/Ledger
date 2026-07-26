'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  type PlainDate,
  CONNECTION_STATUS_LABELS,
  type ConnectionStatus,
  bpsToPercentString,
  daysBetween,
  fromInstant,
} from '@ledger/core';
import { Badge, Button, Money, Panel, PanelBody, PanelHeader, cn } from '@ledger/ui';

/**
 * The attention queue — everything that needs a decision today, in one list.
 *
 * The colour discipline is the whole design of this panel. `--alert` marks the five things that
 * are genuinely problems: a trial about to convert, a price that moved, a cancel-by date closing
 * in, a bank connection that stopped working, and a cancel-by date already missed. Detections
 * waiting in the review queue are *work*, not a problem, so they are `--control` — painting them
 * red teaches the user that red means "there is a list somewhere", and the next time red means
 * "you are about to be charged for something you cancelled" they will not look.
 *
 * Every row is a fact and an action on the same line. A queue that tells you a trial ends on
 * Friday and then makes you go and find the subscription is a notification, not a queue.
 */

// Subscription-scoped rows all resolve to the detail page, which is where the cancellation,
// the price history, and the trial dates live.
function subscriptionHref(id: string): string {
  return `/subscriptions/${id}`;
}

export interface AttentionSubscription {
  readonly id: string;
  readonly displayName: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly trialEndsAt: Date | null;
  readonly cancelByAt: Date | null;
}

export interface AttentionPriceChange {
  readonly subscriptionId: string;
  readonly displayName: string;
  readonly history: {
    readonly id: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly effectiveFrom: string;
    readonly deltaBps: number | null;
  };
}

export interface AttentionConnection {
  readonly id: string;
  readonly institutionName: string;
  readonly status: string;
}

export interface AttentionQueueProps {
  readonly trialsEnding: readonly AttentionSubscription[];
  readonly cancelBySoon: readonly AttentionSubscription[];
  readonly priceChanges: readonly AttentionPriceChange[];
  readonly unhealthyConnections: readonly AttentionConnection[];
  readonly pendingDetectionCount: number;
  readonly today: PlainDate;
  readonly timezone: string;
  readonly locale?: string;
}

interface Item {
  readonly key: string;
  /** Sorts the queue. Lower is more urgent; ties keep source order. */
  readonly rank: number;
  readonly problem: boolean;
  readonly title: React.ReactNode;
  readonly detail: React.ReactNode;
  readonly actionLabel: string;
  readonly href: string;
}

/**
 * "in 3 days" / "today" / "4 days ago", without a relative-time formatter.
 *
 * `Intl.RelativeTimeFormat` would say "in 1 day" where a person says "tomorrow", and these five
 * strings are the ones that appear on the most-read panel in the product.
 */
function inDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0) return `in ${String(days)} days`;
  return `${String(-days)} days ago`;
}

function daysUntil(instant: Date | null, today: PlainDate, timezone: string): number | null {
  if (instant === null) return null;
  try {
    return daysBetween(today, fromInstant(instant, timezone));
  } catch {
    return null;
  }
}

function connectionLabel(status: string): string {
  return Object.hasOwn(CONNECTION_STATUS_LABELS, status)
    ? CONNECTION_STATUS_LABELS[status as ConnectionStatus]
    : 'Not syncing';
}

export function AttentionQueue({
  trialsEnding,
  cancelBySoon,
  priceChanges,
  unhealthyConnections,
  pendingDetectionCount,
  today,
  timezone,
  locale,
}: AttentionQueueProps): React.ReactNode {
  const localeProp = locale === undefined ? {} : { locale };
  const items: Item[] = [];

  for (const subscription of cancelBySoon) {
    const days = daysUntil(subscription.cancelByAt, today, timezone);
    if (days === null) continue;
    const missed = days < 0;
    items.push({
      key: `cancel-${subscription.id}`,
      // A missed cancel-by is the most expensive thing on this page: the charge has already
      // been committed to and the window to do anything about it is closing.
      rank: missed ? 0 : 2,
      problem: true,
      title: subscription.displayName,
      detail: (
        <>
          {missed ? 'Cancel-by date passed ' : 'Cancel by '}
          <span className="font-mono text-text">{inDays(days)}</span>
          {' · '}
          <Money
            amountMinor={subscription.amountMinor}
            currency={subscription.currency}
            tone="outflow"
            size="sm"
            {...localeProp}
          />
          {' next charge'}
        </>
      ),
      actionLabel: 'Start cancellation',
      href: subscriptionHref(subscription.id),
    });
  }

  for (const subscription of trialsEnding) {
    const days = daysUntil(subscription.trialEndsAt, today, timezone);
    if (days === null) continue;
    items.push({
      key: `trial-${subscription.id}`,
      rank: 1,
      problem: true,
      title: subscription.displayName,
      detail: (
        <>
          {'Trial ends '}
          <span className="font-mono text-text">{inDays(days)}</span>
          {' · then '}
          <Money
            amountMinor={subscription.amountMinor}
            currency={subscription.currency}
            tone="outflow"
            size="sm"
            {...localeProp}
          />
        </>
      ),
      actionLabel: 'Review trial',
      href: subscriptionHref(subscription.id),
    });
  }

  for (const change of priceChanges) {
    const bps = change.history.deltaBps;
    // A drop is still a change worth seeing, but it is not a problem — the alert badge is only
    // for the direction that costs money.
    const increased = bps !== null && bps > 0;
    items.push({
      key: `price-${change.history.id}`,
      rank: 3,
      problem: increased,
      title: change.displayName,
      detail: (
        <>
          {'Price changed to '}
          <Money
            amountMinor={change.history.amountMinor}
            currency={change.history.currency}
            tone="outflow"
            size="sm"
            {...localeProp}
          />
          {bps === null ? null : (
            <>
              {' '}
              <Badge tone={increased ? 'alert' : 'reclaim'} mono>
                {bps > 0 ? '+' : ''}
                {bpsToPercentString(bps)}
              </Badge>
            </>
          )}
          {' on '}
          <span className="font-mono">{change.history.effectiveFrom}</span>
        </>
      ),
      actionLabel: 'Review price',
      href: subscriptionHref(change.subscriptionId),
    });
  }

  for (const connection of unhealthyConnections) {
    items.push({
      key: `connection-${connection.id}`,
      rank: 4,
      problem: true,
      title: connection.institutionName,
      detail: <>{connectionLabel(connection.status)} — new charges are not being picked up</>,
      actionLabel: 'Fix connection',
      href: '/connections',
    });
  }

  if (pendingDetectionCount > 0) {
    items.push({
      key: 'detections',
      rank: 5,
      // Work waiting, not a fault. Deliberately not --alert.
      problem: false,
      title:
        pendingDetectionCount === 1
          ? '1 possible subscription found'
          : `${String(pendingDetectionCount)} possible subscriptions found`,
      detail: <>Confirm or dismiss each one so the totals stay right</>,
      actionLabel: 'Open review queue',
      href: '/review',
    });
  }

  items.sort((a, b) => a.rank - b.rank);

  return (
    <Panel>
      <PanelHeader
        eyebrow="Attention"
        actions={
          items.length > 0 ? (
            <span className="font-mono text-xs text-text-2">{items.length}</span>
          ) : null
        }
      />
      <PanelBody className={items.length === 0 ? undefined : 'p-[var(--gap-tight)]'}>
        {items.length === 0 ? (
          // A good state, stated as one. No illustration, no apology, no "you're all caught up!".
          <p className="text-sm text-text-2">Nothing needs you right now.</p>
        ) : (
          <ul className="flex flex-col gap-[var(--gap-tight)]">
            {items.map((item) => (
              <AttentionRow key={item.key} item={item} />
            ))}
          </ul>
        )}
      </PanelBody>
    </Panel>
  );
}

function AttentionRow({ item }: { readonly item: Item }): React.ReactNode {
  return (
    <li
      className={cn(
        'flex flex-col gap-[var(--gap-tight)] rounded-md border bg-ink-700 p-[var(--pad-card)]',
        'transition-[border-color] duration-[var(--duration-fast)] ease-standard hover:border-line-hot',
        'sm:flex-row sm:items-center sm:justify-between sm:gap-[var(--gap)]',
        item.problem ? 'border-alert/30' : 'border-line',
      )}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium leading-tight text-text">
          {item.problem ? (
            <span aria-hidden className="size-1.5 shrink-0 rounded-sm bg-alert" />
          ) : (
            <span aria-hidden className="size-1.5 shrink-0 rounded-sm bg-control" />
          )}
          {item.title}
        </p>
        <p className="mt-1 text-xs leading-snug text-text-2">{item.detail}</p>
      </div>
      <Button asChild size="sm" variant="secondary" className="self-start sm:self-auto">
        <Link href={item.href}>{item.actionLabel}</Link>
      </Button>
    </li>
  );
}
