'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { EmptyState, Skeleton } from '@ledger/ui';
import { api } from '~/lib/trpc';
import type { SpendOverTimeRow } from '~/lib/api-types';
import { LoadError } from '../dashboard/states';
import { ChartFrame } from './chart-frame';
import { chooseCurrency, formatMinor, formatMonthKey, formatMonthShort } from './format';

/**
 * What actually left the account, by month — and the same months a year earlier.
 *
 * Read from posted transactions, not projected from subscriptions. That is the whole point of
 * these two charts: a month with a missed charge, a double charge, or an annual renewal landing
 * should look different here from the commitment total on the dashboard, and a projection would
 * smooth away exactly the thing worth seeing.
 *
 * Two years are fetched once and split into the two charts, because they are the same query and
 * asking twice would let the halves disagree if a sync landed between them.
 */

const MONTHS = 24;

/** Tokens only — Recharts takes CSS variables straight through to the SVG attributes. */
const AXIS = 'var(--text-3)';
const GRID = 'var(--line)';

interface MonthPoint {
  readonly month: string;
  readonly label: string;
  readonly totalMinor: number;
  readonly charges: number;
}

interface YoYPoint {
  readonly month: string;
  readonly label: string;
  readonly thisYearMinor: number;
  readonly lastYearMinor: number;
}

export function SpendPanels({
  locale,
  displayCurrency,
}: {
  readonly locale: string;
  readonly displayCurrency: string;
}): React.ReactNode {
  const spend = api.analytics.spendOverTime.useQuery({ months: MONTHS, subscriptionsOnly: false });

  const { currency, excluded, months } = React.useMemo(
    () => bucketByMonth(spend.data ?? [], displayCurrency, locale),
    [spend.data, displayCurrency, locale],
  );

  if (spend.error !== null) {
    return (
      <LoadError
        what="your spend history"
        error={spend.error}
        retrying={spend.isFetching}
        onRetry={() => {
          void spend.refetch();
        }}
      />
    );
  }

  if (spend.isPending) {
    return (
      <div className="grid gap-[var(--gap-loose)] xl:grid-cols-2">
        <Skeleton className="h-72 w-full rounded-lg" />
        <Skeleton className="h-72 w-full rounded-lg" />
      </div>
    );
  }

  if (currency === null || months.length === 0) {
    return (
      <EmptyState>
        No posted charges yet. Once transactions arrive, this is where the months line up against
        each other.
      </EmptyState>
    );
  }

  const recent = months.slice(-12);
  const recentTotal = recent.reduce((sum, point) => sum + point.totalMinor, 0);
  const yoy = buildYoY(months, locale);
  const excludedNote =
    excluded.length === 0 ? undefined : (
      <>
        Charges in {excluded.join(', ')} are not shown. There is no exchange-rate table yet, and a
        converted total would be a guess presented as a fact.
      </>
    );

  return (
    <div className="grid min-w-0 gap-[var(--gap-loose)] xl:grid-cols-2">
      <ChartFrame<MonthPoint>
        eyebrow="Spend over time"
        caption={`What left the account, ${currency}, last 12 months.`}
        summary={`Monthly spend for the last ${recent.length} months, totalling ${formatMinor(
          recentTotal,
          currency,
          locale,
        )}.`}
        columns={[
          { key: 'month', label: 'Month', value: (row) => row.label },
          {
            key: 'total',
            label: 'Spent',
            numeric: true,
            value: (row) => formatMinor(row.totalMinor, currency, locale),
          },
          { key: 'charges', label: 'Charges', numeric: true, value: (row) => String(row.charges) },
        ]}
        rows={recent}
        rowKey={(row) => row.month}
        {...(excludedNote === undefined ? {} : { footnote: excludedNote })}
      >
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={[...recent]} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="month"
              tickFormatter={(value: string) => formatMonthShort(value, locale)}
              stroke={AXIS}
              tickLine={false}
              axisLine={{ stroke: GRID }}
              fontSize={11}
            />
            <YAxis
              stroke={AXIS}
              tickLine={false}
              axisLine={false}
              fontSize={11}
              tickFormatter={(value: number) => formatMinor(value, currency, locale, true)}
            />
            <Tooltip
              cursor={{ fill: 'var(--ink-600)' }}
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={(value: string) => formatMonthKey(value, locale)}
              formatter={(value: number) => formatMinor(value, currency, locale)}
            />
            <Bar dataKey="totalMinor" name="Spent" fill="var(--outflow)" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>

      <ChartFrame<YoYPoint>
        eyebrow="Year over year"
        caption="This year against the same month last year."
        summary={yoySummary(yoy, currency, locale)}
        columns={[
          { key: 'month', label: 'Month', value: (row) => row.label },
          {
            key: 'last',
            label: 'Last year',
            numeric: true,
            value: (row) => formatMinor(row.lastYearMinor, currency, locale),
          },
          {
            key: 'this',
            label: 'This year',
            numeric: true,
            value: (row) => formatMinor(row.thisYearMinor, currency, locale),
          },
        ]}
        rows={yoy}
        rowKey={(row) => row.month}
        footnote={
          yoy.length === 0
            ? 'Not enough history yet — this needs two charges in the same month, a year apart.'
            : undefined
        }
      >
        {yoy.length === 0 ? (
          <p className="py-10 text-center text-xs text-text-3">
            Come back once there are two years of charges.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={[...yoy]} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis
                dataKey="month"
                tickFormatter={(value: string) => formatMonthShort(value, locale)}
                stroke={AXIS}
                tickLine={false}
                axisLine={{ stroke: GRID }}
                fontSize={11}
              />
              <YAxis
                stroke={AXIS}
                tickLine={false}
                axisLine={false}
                fontSize={11}
                tickFormatter={(value: number) => formatMinor(value, currency, locale, true)}
              />
              <Tooltip
                cursor={{ fill: 'var(--ink-600)' }}
                contentStyle={TOOLTIP_STYLE}
                labelFormatter={(value: string) => formatMonthKey(value, locale)}
                formatter={(value: number) => formatMinor(value, currency, locale)}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: 'var(--text-3)' }} />
              {/* Last year sits behind in a muted fill: it is the reference, not the subject. */}
              <Bar dataKey="lastYearMinor" name="Last year" fill="var(--ink-500)" radius={[2, 2, 0, 0]} />
              <Bar dataKey="thisYearMinor" name="This year" fill="var(--outflow)" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartFrame>
    </div>
  );
}

const TOOLTIP_STYLE: React.CSSProperties = {
  background: 'var(--ink-700)',
  border: '1px solid var(--line-strong)',
  borderRadius: 'var(--radius)',
  fontSize: '0.75rem',
  color: 'var(--text)',
};

/** One currency, one row per month, gaps filled — a missing month is a real zero, not a hole. */
function bucketByMonth(
  rows: readonly SpendOverTimeRow[],
  preferred: string,
  locale: string,
): { currency: string | null; excluded: readonly string[]; months: readonly MonthPoint[] } {
  const { currency, excluded } = chooseCurrency(rows, preferred);
  if (currency === null) return { currency: null, excluded, months: [] };

  const kept = rows.filter((row) => row.currency === currency);
  const byMonth = new Map(kept.map((row) => [row.month, row]));
  const keys = [...byMonth.keys()].sort();
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (first === undefined || last === undefined) return { currency, excluded, months: [] };

  const months: MonthPoint[] = [];
  for (const key of enumerateMonths(first, last)) {
    const row = byMonth.get(key);
    months.push({
      month: key,
      label: formatMonthKey(key, locale),
      totalMinor: row?.totalMinor ?? 0,
      charges: row?.charges ?? 0,
    });
  }
  return { currency, excluded, months };
}

/** Inclusive month keys from `from` to `to`. Integer arithmetic — no `Date` month rollover. */
function enumerateMonths(from: string, to: string): string[] {
  const start = monthIndex(from);
  const end = monthIndex(to);
  if (start === null || end === null || end < start) return [];

  const keys: string[] = [];
  for (let index = start; index <= end; index += 1) {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    keys.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
  }
  return keys;
}

function monthIndex(key: string): number | null {
  const [year, month] = key.split('-');
  const y = Number.parseInt(year ?? '', 10);
  const m = Number.parseInt(month ?? '', 10);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return null;
  return y * 12 + (m - 1);
}

/**
 * The last twelve months paired with the twelve before them.
 *
 * A month is only included when there is a real month twelve back to compare it against —
 * charting "this year 40, last year 0" for a month that predates the account is a fall, and it
 * is the one shape a year-over-year chart must never invent.
 */
function buildYoY(months: readonly MonthPoint[], locale: string): readonly YoYPoint[] {
  const byKey = new Map(months.map((point) => [point.month, point]));
  const recent = months.slice(-12);

  const points: YoYPoint[] = [];
  for (const point of recent) {
    const index = monthIndex(point.month);
    if (index === null) continue;
    const priorIndex = index - 12;
    const priorYear = Math.floor(priorIndex / 12);
    const priorMonth = (priorIndex % 12) + 1;
    const priorKey = `${String(priorYear).padStart(4, '0')}-${String(priorMonth).padStart(2, '0')}`;
    const prior = byKey.get(priorKey);
    if (prior === undefined) continue;

    points.push({
      month: point.month,
      label: formatMonthKey(point.month, locale),
      thisYearMinor: point.totalMinor,
      lastYearMinor: prior.totalMinor,
    });
  }
  return points;
}

function yoySummary(points: readonly YoYPoint[], currency: string, locale: string): string {
  if (points.length === 0) return 'Not enough history to compare years yet.';
  const thisYear = points.reduce((sum, point) => sum + point.thisYearMinor, 0);
  const lastYear = points.reduce((sum, point) => sum + point.lastYearMinor, 0);
  const direction = thisYear === lastYear ? 'the same as' : thisYear > lastYear ? 'more than' : 'less than';
  return `Over the last ${points.length} comparable months you spent ${formatMinor(
    thisYear,
    currency,
    locale,
  )}, ${direction} the ${formatMinor(lastYear, currency, locale)} in the same months a year earlier.`;
}
