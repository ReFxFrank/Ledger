'use client';

import * as React from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CATEGORY_LABELS } from '@ledger/core';
import { EmptyState, Skeleton } from '@ledger/ui';
import { api } from '~/lib/trpc';
import type { CadenceMixRow, CategorySpend } from '~/lib/api-types';
import { LoadError } from '../dashboard/states';
import { ChartFrame } from './chart-frame';
import { formatMinor } from './format';

/**
 * Where the money goes, and how often.
 *
 * Both panels come out of `aggregateCommitments` / `aggregateByCategory` in @ledger/core — the
 * same summation the dashboard totals and the subscriptions table use. Brief Phase 8 requires
 * every figure on this screen to reconcile exactly with the subscriptions table, and the only way
 * to guarantee that is to have one summation rather than two that happen to agree today.
 *
 * Everything here is a single hue. These are all outflows, so amber is the honest colour for all
 * of them and the *length* of the bar is what carries the comparison — a rainbow would imply a
 * distinction between categories that does not exist.
 */

const AXIS = 'var(--text-3)';
const GRID = 'var(--line)';

const TOOLTIP_STYLE: React.CSSProperties = {
  background: 'var(--ink-700)',
  border: '1px solid var(--line-strong)',
  borderRadius: 'var(--radius)',
  fontSize: '0.75rem',
  color: 'var(--text)',
};

export function CategoryBreakdown({ locale }: { readonly locale: string }): React.ReactNode {
  const categories = api.analytics.spendByCategory.useQuery();

  if (categories.error !== null) {
    return (
      <LoadError
        what="the category breakdown"
        error={categories.error}
        retrying={categories.isFetching}
        onRetry={() => {
          void categories.refetch();
        }}
      />
    );
  }

  if (categories.isPending) return <Skeleton className="h-72 w-full rounded-lg" />;

  const rows = categories.data;
  if (rows.length === 0) {
    return (
      <EmptyState>
        Nothing to break down yet. Categories appear as soon as there is a subscription in one.
      </EmptyState>
    );
  }

  const currency = rows[0]?.currency ?? 'USD';
  const annualTotal = rows.reduce((sum, row) => sum + row.annualMinor, 0);
  const biggest = rows[0];

  const data = rows.map((row) => ({ ...row, label: CATEGORY_LABELS[row.category] }));

  return (
    <ChartFrame<CategorySpend & { label: string }>
      eyebrow="Where it goes"
      caption="Annual commitment by category."
      summary={
        biggest === undefined
          ? 'No categories yet.'
          : `${rows.length} categories, ${formatMinor(annualTotal, currency, locale)} a year in total. The largest is ${
              CATEGORY_LABELS[biggest.category]
            } at ${formatMinor(biggest.annualMinor, currency, locale)} a year.`
      }
      columns={[
        { key: 'category', label: 'Category', value: (row) => row.label },
        { key: 'count', label: 'Subs', numeric: true, value: (row) => String(row.count) },
        {
          key: 'monthly',
          label: 'Monthly',
          numeric: true,
          value: (row) => formatMinor(row.monthlyMinor, row.currency, locale),
        },
        {
          key: 'annual',
          label: 'Annual',
          numeric: true,
          value: (row) => formatMinor(row.annualMinor, row.currency, locale),
        },
      ]}
      rows={data}
      rowKey={(row) => row.category}
    >
      <ResponsiveContainer width="100%" height={Math.max(180, data.length * 30 + 24)}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 12, bottom: 0, left: 0 }}
          barCategoryGap={6}
        >
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis
            type="number"
            stroke={AXIS}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            fontSize={11}
            tickFormatter={(value: number) => formatMinor(value, currency, locale, true)}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={120}
            stroke={AXIS}
            tickLine={false}
            axisLine={false}
            fontSize={11}
          />
          <Tooltip
            cursor={{ fill: 'var(--ink-600)' }}
            contentStyle={TOOLTIP_STYLE}
            formatter={(value: number) => formatMinor(value, currency, locale)}
          />
          <Bar dataKey="annualMinor" name="Per year" fill="var(--outflow)" radius={[0, 2, 2, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/**
 * How the portfolio splits across billing cadences.
 *
 * Weekly and four-weekly are the rows worth looking at: people file both as "monthly" and they
 * are 52 and 13 charges a year, not 12. A segmented bar rather than a chart library, because the
 * question here is "what share" and five rows do not need axes.
 */
export function CadenceMix({ locale }: { readonly locale: string }): React.ReactNode {
  const cadences = api.analytics.cadenceMix.useQuery();

  if (cadences.error !== null) {
    return (
      <LoadError
        what="the cadence mix"
        error={cadences.error}
        retrying={cadences.isFetching}
        onRetry={() => {
          void cadences.refetch();
        }}
      />
    );
  }

  if (cadences.isPending) return <Skeleton className="h-56 w-full rounded-lg" />;

  const rows = cadences.data;
  if (rows.length === 0) {
    return <EmptyState>No cadences to compare yet.</EmptyState>;
  }

  const total = rows.reduce((sum, row) => sum + row.annualMinor, 0);
  const currency = rows[0]?.currency ?? 'USD';

  return (
    <ChartFrame<CadenceMixRow>
      eyebrow="Cadence mix"
      caption="How your annual commitment splits across billing intervals."
      summary={`${rows.length} distinct billing cadences, ${formatMinor(
        total,
        currency,
        locale,
      )} a year in total.`}
      columns={[
        { key: 'label', label: 'Cadence', value: (row) => row.label },
        { key: 'count', label: 'Subs', numeric: true, value: (row) => String(row.subscriptions) },
        {
          key: 'annual',
          label: 'Annual',
          numeric: true,
          value: (row) => formatMinor(row.annualMinor, row.currency, locale),
        },
        {
          key: 'share',
          label: 'Share',
          numeric: true,
          value: (row) => `${shareOf(row.annualMinor, total)}%`,
        },
      ]}
      rows={rows}
      rowKey={(row) => row.key}
      footnote="A four-weekly subscription bills thirteen times a year, not twelve. That is why it is on its own row."
    >
      <div className="flex flex-col gap-[var(--gap-loose)]">
        <div className="flex h-3 w-full overflow-hidden rounded-sm bg-ink-600">
          {rows.map((row, index) => (
            <span
              key={row.key}
              className="h-full border-r border-ink-800 last:border-r-0"
              style={{
                width: `${shareOf(row.annualMinor, total)}%`,
                backgroundColor: 'var(--outflow)',
                // One hue, stepped in opacity: the segments have to be told apart, and a second
                // colour here would mean something the data does not say.
                opacity: Math.max(0.35, 1 - index * 0.15),
              }}
            />
          ))}
        </div>

        <ul className="flex flex-col gap-1.5">
          {rows.map((row, index) => (
            <li key={row.key} className="flex items-center gap-2 text-xs">
              <span
                className="size-2 shrink-0 rounded-sm"
                style={{
                  backgroundColor: 'var(--outflow)',
                  opacity: Math.max(0.35, 1 - index * 0.15),
                }}
              />
              <span className="min-w-0 flex-1 truncate text-text-2">{row.label}</span>
              <span className="font-mono tabular-nums text-text-3">{row.subscriptions}</span>
              <span className="w-24 text-right font-mono tabular-nums text-outflow">
                {formatMinor(row.annualMinor, row.currency, locale)}
              </span>
              <span className="w-10 text-right font-mono tabular-nums text-text-3">
                {shareOf(row.annualMinor, total)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </ChartFrame>
  );
}

/** Integer percent. Money never becomes a float; the share is a display value, rounded once. */
function shareOf(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part * 100) / total);
}
