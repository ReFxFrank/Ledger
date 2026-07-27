'use client';

import * as React from 'react';
import { formatPlainDate, fromInstant, parsePlainDate } from '@ledger/core';
import { Panel, PanelBody, PanelHeader } from '@ledger/ui';
import { api } from '~/lib/trpc';
import { AttentionQueue } from '~/components/dashboard/attention-queue';
import { BillingHorizon, type HorizonDeadline } from '~/components/dashboard/billing-horizon';
import { CommitmentSummary } from '~/components/dashboard/commitment-summary';
import { RecentChanges } from '~/components/dashboard/recent-changes';
import {
  BillingHorizonSkeleton,
  LoadError,
  PanelError,
  RowsSkeleton,
  SummarySkeleton,
} from '~/components/dashboard/states';

/**
 * The dashboard.
 *
 * One thing is the hero and everything else is quieter than it. The Billing Horizon answers
 * "what is about to happen to my money"; the totals answer "how much of this is there"; the
 * attention queue answers "what do I have to do". In that order, at that weight — a page where
 * four panels all shout is a page where the timeline stops being the product.
 *
 * Each panel owns its own loading and failure. One query failing must not blank the other three:
 * a dashboard that hides the totals because the review-queue count timed out is less useful than
 * one that shows the totals and says the count is missing.
 */
export default function DashboardPage(): React.ReactNode {
  const horizon = api.dashboard.horizon.useQuery({ days: 60 });
  const totals = api.dashboard.totals.useQuery();
  const attention = api.dashboard.attention.useQuery();
  const recent = api.dashboard.recentChanges.useQuery({ limit: 8 });
  const me = api.me.current.useQuery();

  // Read once per mount. Only ever used for "3d ago" style labels, which render after the
  // queries resolve — so it never participates in the server-rendered pass.
  const [now] = React.useState(() => new Date());

  const timezone = me.data?.timezone ?? 'UTC';
  const locale = me.data?.locale;

  /**
   * Cancel-by dates come from the attention query, not the horizon query: a deadline is not a
   * charge and the horizon procedure deliberately only projects occurrences. Drawing them on the
   * same axis is the point — the deadline is only meaningful next to the charge it precedes.
   */
  const deadlines = React.useMemo<HorizonDeadline[]>(() => {
    const rows = attention.data?.cancelBySoon ?? [];
    const from = horizon.data?.from;
    if (from === undefined) return [];

    return rows.flatMap((row) => {
      if (row.cancelByAt === null) return [];
      const date = fromInstant(row.cancelByAt, timezone);
      const iso = formatPlainDate(date);
      return [
        {
          date: iso,
          subscriptionId: row.id,
          displayName: row.displayName,
          // String comparison is safe: both sides are zero-padded YYYY-MM-DD.
          missed: iso < from,
        },
      ];
    });
  }, [attention.data, horizon.data, timezone]);

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-[var(--gap-loose)] p-[var(--pad-panel)]">
      {/* The page heading is the top bar's `<h1>` — the shell owns the only one on the page. */}

      {/* ── the hero ─────────────────────────────────────────────────────────────────── */}
      {horizon.isPending ? (
        <BillingHorizonSkeleton />
      ) : horizon.isError ? (
        <PanelError
          eyebrow="Billing horizon"
          what="the billing horizon"
          error={horizon.error}
          onRetry={() => {
            void horizon.refetch();
          }}
          retrying={horizon.isFetching}
        />
      ) : (
        <BillingHorizon
          from={horizon.data.from}
          to={horizon.data.to}
          charges={horizon.data.ticks}
          deadlines={deadlines}
          {...(locale === undefined ? {} : { locale })}
        />
      )}

      {/* ── the totals, deliberately quieter ─────────────────────────────────────────── */}
      {totals.isPending ? (
        <SummarySkeleton />
      ) : totals.isError ? (
        <LoadError
          what="your commitment totals"
          error={totals.error}
          onRetry={() => {
            void totals.refetch();
          }}
          retrying={totals.isFetching}
        />
      ) : (
        <CommitmentSummary
          monthlyMinor={totals.data.monthlyMinor}
          annualMinor={totals.data.annualMinor}
          currency={totals.data.currency}
          count={totals.data.count}
          unconvertibleIds={totals.data.unconvertibleIds}
          approximateIds={totals.data.approximateIds}
          approximateRateDate={totals.data.approximateRateDate}
          {...(locale === undefined ? {} : { locale })}
        />
      )}

      <div className="grid items-start gap-[var(--gap-loose)] lg:grid-cols-[1.1fr_1fr]">
        {/*
          The review-queue count lives inside this panel rather than in a strip of its own:
          pending detections are one of the things that can want a decision, and lifting one of
          them into a second widget would give the user two places to look for "what needs me",
          which is the exact failure the queue exists to fix.
        */}
        {attention.isPending || horizon.data === undefined ? (
          <Panel>
            <PanelHeader eyebrow="Attention" />
            <PanelBody>
              <RowsSkeleton rows={3} />
            </PanelBody>
          </Panel>
        ) : attention.isError ? (
          <PanelError
            eyebrow="Attention"
            what="the attention queue"
            error={attention.error}
            onRetry={() => {
              void attention.refetch();
            }}
            retrying={attention.isFetching}
          />
        ) : (
          <AttentionQueue
            trialsEnding={attention.data.trialsEnding}
            cancelBySoon={attention.data.cancelBySoon}
            priceChanges={attention.data.priceChanges}
            unhealthyConnections={attention.data.unhealthyConnections}
            pendingDetectionCount={attention.data.pendingDetectionCount}
            // The server's today, in the user's timezone — not the browser's clock.
            today={parsePlainDate(horizon.data.from)}
            timezone={timezone}
            {...(locale === undefined ? {} : { locale })}
          />
        )}

        {recent.isPending ? (
          <Panel>
            <PanelHeader eyebrow="Recent changes" />
            <PanelBody>
              <RowsSkeleton rows={5} />
            </PanelBody>
          </Panel>
        ) : recent.isError ? (
          <PanelError
            eyebrow="Recent changes"
            what="recent changes"
            error={recent.error}
            onRetry={() => {
              void recent.refetch();
            }}
            retrying={recent.isFetching}
          />
        ) : (
          <RecentChanges
            items={recent.data}
            now={now}
            {...(locale === undefined ? {} : { locale })}
          />
        )}
      </div>
    </div>
  );
}
