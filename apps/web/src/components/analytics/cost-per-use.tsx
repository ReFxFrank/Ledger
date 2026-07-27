'use client';

import * as React from 'react';
import Link from 'next/link';
import { CATEGORY_LABELS } from '@ledger/core';
import {
  Badge,
  Button,
  EmptyState,
  Money,
  Panel,
  PanelBody,
  PanelHeader,
  Skeleton,
  cn,
  focusRing,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import { LoadError } from '../dashboard/states';

/**
 * Cost per use — the number that makes someone cancel.
 *
 * Never-used subscriptions sit at the top, because "paid for, never opened" is the strongest
 * signal on the page and burying it under a sorted column would be hiding the answer inside the
 * question. They show as "never used" rather than as an infinity or a division artifact.
 *
 * The window spend is the charges that actually fall inside the window, counted with
 * `occurrencesBetween` on the server — not "monthly cost × 3". A quarterly subscription
 * contributes one charge to a 90-day window or two depending on where its anchor sits, and
 * averaging that away is how the figure stops being believable.
 *
 * A table, not a chart: this is a ranked list of rows the user acts on individually, and the
 * comparison that matters is between two rows next to each other.
 */

const WINDOWS: readonly { readonly days: number; readonly label: string }[] = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '180 days' },
  { days: 365, label: '1 year' },
];

export function CostPerUse({ locale }: { readonly locale: string }): React.ReactNode {
  const [days, setDays] = React.useState(90);
  const rows = api.analytics.costPerUse.useQuery({ days });

  return (
    <Panel className="min-w-0">
      <PanelHeader
        eyebrow="Cost per use"
        actions={
          <div role="group" aria-label="Window" className="flex flex-wrap gap-1">
            {WINDOWS.map((window) => (
              <button
                key={window.days}
                type="button"
                aria-pressed={days === window.days}
                onClick={() => {
                  setDays(window.days);
                }}
                className={cn(
                  'rounded-sm border px-2 py-1 text-[0.6875rem] leading-4',
                  'transition-[background-color,border-color,color] duration-[var(--duration-fast)] ease-standard',
                  focusRing,
                  days === window.days
                    ? 'border-control bg-control-dim text-control-2'
                    : 'border-line bg-ink-700 text-text-2 hover:border-line-hot hover:text-text',
                )}
              >
                {window.label}
              </button>
            ))}
          </div>
        }
      >
        What each subscription cost you over the window, divided by the times you logged using it.
      </PanelHeader>

      {rows.error !== null ? (
        <PanelBody>
          <LoadError
            what="cost per use"
            error={rows.error}
            retrying={rows.isFetching}
            onRetry={() => {
              void rows.refetch();
            }}
          />
        </PanelBody>
      ) : rows.isPending ? (
        <PanelBody className="flex flex-col gap-1.5">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <Skeleton key={row} className="h-8 w-full" />
          ))}
        </PanelBody>
      ) : rows.data.length === 0 ? (
        <EmptyState
          actions={
            <Button size="sm" variant="secondary" asChild>
              <Link href="/subscriptions">Open your subscriptions</Link>
            </Button>
          }
        >
          Nothing to rank yet. Log a use on any subscription and its cost per use appears here.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[38rem] text-left text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="eyebrow px-[var(--pad-panel)] py-2 font-medium">
                  Subscription
                </th>
                <th scope="col" className="eyebrow py-2 pr-3 font-medium">
                  Category
                </th>
                <th scope="col" className="eyebrow py-2 pr-3 text-right font-medium">
                  Charges
                </th>
                <th scope="col" className="eyebrow py-2 pr-3 text-right font-medium">
                  Spent
                </th>
                <th scope="col" className="eyebrow py-2 pr-3 text-right font-medium">
                  Uses
                </th>
                <th
                  scope="col"
                  className="eyebrow py-2 pr-[var(--pad-panel)] text-right font-medium"
                >
                  Per use
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.data.map((row) => {
                // Pulled out of the row so the narrowing survives into the JSX below: a null
                // cost-per-use is "never used", not zero, and the two must not render the same.
                const perUseMinor = row.costPerUseMinor;
                return (
                  <tr
                    key={row.id}
                    className="border-b border-line transition-colors duration-[var(--duration-fast)] ease-standard last:border-b-0 hover:bg-ink-700"
                  >
                    <td className="px-[var(--pad-panel)] py-2">
                      <Link
                        href={`/subscriptions/${row.id}`}
                        className={cn(
                          'rounded-sm text-text hover:text-control-2',
                          'transition-colors duration-[var(--duration-fast)] ease-standard',
                          focusRing,
                        )}
                      >
                        {row.displayName}
                      </Link>
                    </td>
                    <td className="py-2 pr-3 text-text-2">{CATEGORY_LABELS[row.category]}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-text-3">
                      {row.charges}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <Money
                        amountMinor={row.windowSpendMinor}
                        currency={row.currency}
                        tone="outflow"
                        size="sm"
                        locale={locale}
                      />
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-text-2">
                      {row.uses}
                    </td>
                    <td className="py-2 pr-[var(--pad-panel)] text-right">
                      {perUseMinor === null ? (
                        // Not `--alert`: never using something you pay for is a decision to
                        // reconsider, not a fault. Amber is the colour of money leaving, and this
                        // is money leaving for nothing.
                        <Badge tone="outflow">Never used</Badge>
                      ) : (
                        <Money
                          amountMinor={perUseMinor}
                          currency={row.currency}
                          tone="outflow"
                          size="sm"
                          locale={locale}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
