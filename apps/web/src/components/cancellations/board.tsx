'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, Slash } from 'lucide-react';
import {
  CANCELLATION_METHOD_LABELS,
  fromInstant,
  interval,
  intervalLabel,
} from '@ledger/core';
import {
  Badge,
  Button,
  EmptyState,
  Money,
  Panel,
  PanelBody,
  PanelHeader,
  cn,
  focusRing,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import { formatDay } from '~/lib/format';
import type { CancellationBoardItem } from '~/lib/api-types';
import { LoadError } from '../dashboard/states';
import { CancellationBoardSkeleton } from './skeletons';

/**
 * The cancellation board.
 *
 * Columns are the workflow states, in the order they happen, and `Confirmed by provider` is one
 * of them: a provider saying "cancelled" is a claim, and the request stays on the board until the
 * bank feed agrees. A card that vanished the moment the provider claimed success would be a card
 * nobody ever checks again.
 *
 * A missed cancel-by is the only thing on this screen painted `--alert`. Everything else here is
 * work in progress, and work in progress is not a problem.
 */
export function CancellationBoard(): React.ReactNode {
  const board = api.cancellations.board.useQuery();
  const me = api.me.current.useQuery();

  const locale = me.data?.locale ?? 'en-GB';
  const timezone = me.data?.timezone ?? 'UTC';

  if (board.error !== null) {
    return (
      <LoadError
        what="your cancellations"
        error={board.error}
        retrying={board.isFetching}
        onRetry={() => {
          void board.refetch();
        }}
      />
    );
  }

  if (board.isPending) return <CancellationBoardSkeleton />;

  const total = board.data.columns.reduce((sum, column) => sum + column.items.length, 0);

  if (total === 0) {
    return (
      <Panel>
        <PanelHeader eyebrow="Cancellations">Nothing on the board.</PanelHeader>
        <EmptyState
          icon={<Slash />}
          actions={
            <Button size="sm" variant="primary" asChild>
              <Link href="/subscriptions">Pick something to cancel</Link>
            </Button>
          }
        >
          Start a cancellation from any subscription and it appears here with its checklist, its
          cancel-by date, and somewhere to keep the confirmation.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-[var(--gap-loose)]">
      {board.data.overdueCount > 0 ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-md border border-alert/35 bg-alert-dim p-[var(--pad-card)]"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-alert" aria-hidden />
          <p className="text-[0.8125rem] text-text">
            <span className="font-medium text-alert">
              {board.data.overdueCount}{' '}
              {board.data.overdueCount === 1 ? 'cancel-by date has' : 'cancel-by dates have'} passed.
            </span>{' '}
            The next charge is likely to go through. Finish these first, and keep whatever the
            provider sends you.
          </p>
        </div>
      ) : null}

      {/*
        Four columns from `lg`, stacked below it. Not a horizontally scrolling board on a phone:
        a column you have to swipe to find is a column you forget, and the deadline is the whole
        point of this screen.
      */}
      <div className="grid gap-[var(--gap)] lg:grid-cols-4">
        {board.data.columns.map((column) => (
          <Panel key={column.status} className="flex min-w-0 flex-col">
            <PanelHeader
              eyebrow={column.label}
              actions={
                <span className="font-mono text-xs tabular-nums text-text-3">
                  {column.items.length}
                </span>
              }
            />
            <PanelBody className="flex min-w-0 flex-col gap-[var(--gap-tight)]">
              {column.items.length === 0 ? (
                <p className="text-xs text-text-3">Nothing here.</p>
              ) : (
                column.items.map((item) => (
                  <BoardCard
                    key={item.request.id}
                    item={item}
                    locale={locale}
                    timezone={timezone}
                  />
                ))
              )}
            </PanelBody>
          </Panel>
        ))}
      </div>
    </div>
  );
}

function BoardCard({
  item,
  locale,
  timezone,
}: {
  readonly item: CancellationBoardItem;
  readonly locale: string;
  readonly timezone: string;
}): React.ReactNode {
  const request = item.request;
  const days = item.daysUntilDeadline;

  return (
    <Link
      href={`/cancellations/${request.id}`}
      className={cn(
        'block rounded-md border bg-ink-700 p-[var(--pad-card)] shadow-card',
        'transition-[border-color,box-shadow,transform] duration-[var(--duration-fast)] ease-standard',
        'hover:-translate-y-px hover:shadow-raised',
        focusRing,
        item.overdue ? 'border-alert/35 hover:border-alert/60' : 'border-line hover:border-line-hot',
      )}
    >
      <p className="truncate text-[0.8125rem] font-medium leading-tight text-text">
        {item.subscriptionName}
      </p>

      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-2">
        <Money
          amountMinor={item.amountMinor}
          currency={item.currency}
          tone="outflow"
          size="sm"
          locale={locale}
        />
        <span aria-hidden className="text-text-3">
          ·
        </span>
        <span>{intervalLabel(interval(item.intervalUnit, item.intervalCount))}</span>
      </p>

      <p className="mt-2 text-[0.6875rem] text-text-3">
        {CANCELLATION_METHOD_LABELS[request.method]}
      </p>

      {request.deadlineAt === null ? (
        <p className="mt-2 text-[0.6875rem] text-text-3">No cancel-by date</p>
      ) : (
        <p className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="eyebrow">Cancel by</span>
          <time
            dateTime={request.deadlineAt.toISOString()}
            className={cn(
              'font-mono text-xs tabular-nums',
              item.overdue ? 'text-alert' : 'text-text-2',
            )}
          >
            {formatDay(fromInstant(request.deadlineAt, timezone), locale)}
          </time>
          {days === null ? null : (
            <Badge tone={item.overdue ? 'alert' : days <= 3 ? 'outflow' : 'neutral'} mono>
              {item.overdue
                ? `${Math.abs(days)}d late`
                : days === 0
                  ? 'today'
                  : `${days}d left`}
            </Badge>
          )}
        </p>
      )}
    </Link>
  );
}
