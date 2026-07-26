'use client';

/**
 * The two panels that answer "what has this actually done to me": every charge the bank has
 * matched to it, and every price it has been.
 */

import * as React from 'react';
import Link from 'next/link';
import { Link2, Receipt, TrendingUp } from 'lucide-react';
import { formatPlainDate, fromInstant, parsePlainDate, toEpochDay } from '@ledger/core';
import { Badge, Button, EmptyState, Money, MoneyDelta, Panel, PanelBody, PanelHeader, Skeleton } from '@ledger/ui';
import { formatDay } from '~/lib/format';

export interface ChargeRow {
  readonly id: string;
  readonly postedAt: Date;
  readonly amountMinor: number;
  readonly currency: string;
  readonly rawDescriptor: string;
  readonly pending: boolean;
}

export interface ChargeTimelineProps {
  readonly charges: readonly ChargeRow[];
  readonly loading: boolean;
  readonly locale: string;
  readonly timezone: string;
}

export function ChargeTimeline({
  charges,
  loading,
  locale,
  timezone,
}: ChargeTimelineProps): React.ReactElement {
  return (
    <Panel>
      <PanelHeader eyebrow="Charge timeline" />
      {loading ? (
        <PanelBody className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </PanelBody>
      ) : charges.length === 0 ? (
        <EmptyState
          icon={<Receipt />}
          actions={
            <Button size="sm" variant="secondary" asChild>
              <Link href="/connections">
                <Link2 className="size-3.5" aria-hidden />
                Connect an account
              </Link>
            </Button>
          }
        >
          No charges matched to this yet. Connect an account and they line up here automatically.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {charges.map((charge) => {
            const date = fromInstant(charge.postedAt, timezone);
            return (
              <li
                key={charge.id}
                className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-[var(--gap-tight)] px-[var(--pad-panel)] py-2"
              >
                <time dateTime={formatPlainDate(date)} className="font-mono text-xs text-text-2">
                  {formatDay(date, locale)}
                </time>
                {/* The descriptor exactly as the bank sent it — mono, because it is evidence. */}
                <span className="truncate font-mono text-[0.6875rem] uppercase tracking-[0.04em] text-text-3">
                  {charge.rawDescriptor}
                </span>
                <span className="flex items-center gap-1.5 justify-self-end">
                  {charge.pending ? <Badge tone="neutral">Pending</Badge> : null}
                  <Money
                    amountMinor={charge.amountMinor}
                    currency={charge.currency}
                    tone="outflow"
                    locale={locale}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export interface PricePoint {
  readonly id: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly deltaBps: number | null;
}

export interface PriceHistoryProps {
  readonly history: readonly PricePoint[];
  readonly locale: string;
}

/**
 * Price history.
 *
 * The sparkline is positioned by date rather than by index, because four years of a stable price
 * followed by two hikes in one quarter is a shape, and evenly spacing the points hides it.
 */
export function PriceHistory({ history, locale }: PriceHistoryProps): React.ReactElement {
  const points = React.useMemo(() => buildPoints(history), [history]);

  return (
    <Panel>
      <PanelHeader eyebrow="Price history" />
      {history.length === 0 ? (
        <EmptyState icon={<TrendingUp />}>
          No price points recorded yet. The first one lands when this is charged or edited.
        </EmptyState>
      ) : (
        <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
          {points === null ? null : <Sparkline points={points} />}

          <ul className="flex flex-col gap-[var(--gap-tight)]">
            {history.map((point, index) => {
              const previous = index === 0 ? undefined : history[index - 1];
              return (
                <li key={point.id} className="flex flex-wrap items-center justify-between gap-[var(--gap-tight)]">
                  <time dateTime={point.effectiveFrom} className="font-mono text-xs text-text-3">
                    {formatDay(parsePlainDate(point.effectiveFrom), locale)}
                  </time>
                  {previous === undefined ? (
                    <span className="flex items-center gap-1.5">
                      <span className="eyebrow">Started at</span>
                      <Money
                        amountMinor={point.amountMinor}
                        currency={point.currency}
                        tone="outflow"
                        locale={locale}
                      />
                    </span>
                  ) : (
                    // MoneyDelta computes its percentage from the same integer basis points the
                    // detector compares against its 3% threshold, so the UI cannot claim a
                    // different figure from the one that raised the alert.
                    <MoneyDelta
                      from={{ amountMinor: previous.amountMinor, currency: previous.currency }}
                      to={{ amountMinor: point.amountMinor, currency: point.currency }}
                      locale={locale}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </PanelBody>
      )}
    </Panel>
  );
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Normalises the history into unit coordinates.
 *
 * Returns null when the series cannot be drawn honestly: fewer than two points, or a currency
 * change part-way through, where a single line would imply a comparison that does not exist.
 */
function buildPoints(history: readonly PricePoint[]): readonly Point[] | null {
  const first = history[0];
  if (first === undefined || history.length < 2) return null;
  if (history.some((point) => point.currency !== first.currency)) return null;

  const days = history.map((point) => toEpochDay(parsePlainDate(point.effectiveFrom)));
  const amounts = history.map((point) => point.amountMinor);

  const minDay = Math.min(...days);
  const maxDay = Math.max(...days);
  const minAmount = Math.min(...amounts);
  const maxAmount = Math.max(...amounts);

  const daySpan = maxDay - minDay;
  const amountSpan = maxAmount - minAmount;

  return history.map((_point, index) => ({
    x: daySpan === 0 ? index / (history.length - 1) : ((days[index] ?? minDay) - minDay) / daySpan,
    // A flat series sits on the centre line rather than collapsing onto the floor of the box.
    y: amountSpan === 0 ? 0.5 : ((amounts[index] ?? minAmount) - minAmount) / amountSpan,
  }));
}

/**
 * A 100×28 unit box stretched to the panel width. Amber, because every point on it is money
 * leaving. Decorative: the exact figures are in the list underneath, so it is `aria-hidden`.
 */
function Sparkline({ points }: { readonly points: readonly Point[] }): React.ReactElement {
  const path = points
    .map((point) => `${(point.x * 100).toFixed(2)},${(28 - point.y * 26 - 1).toFixed(2)}`)
    .join(' ');

  return (
    <svg
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      role="presentation"
      aria-hidden
      className="h-12 w-full rounded-sm border border-line bg-ink-900"
    >
      <polyline
        points={path}
        fill="none"
        stroke="var(--outflow)"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}
