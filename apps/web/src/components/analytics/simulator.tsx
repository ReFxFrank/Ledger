'use client';

import * as React from 'react';
import { Search, Sparkles } from 'lucide-react';
import { interval, intervalLabel } from '@ledger/core';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Input,
  Money,
  Panel,
  PanelBody,
  PanelHeader,
  Skeleton,
  cn,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import type { SimulationResult } from '~/lib/api-types';
import { LoadError } from '../dashboard/states';
import { MerchantMark } from '../merchant-mark';

/**
 * The cancel simulator.
 *
 * Tick subscriptions, watch the monthly and annual figures move. The arithmetic happens on the
 * server through `simulateCancellations`, which runs the same aggregation over the portfolio with
 * and without the selection — so a currency that cannot be converted is excluded from both sides
 * consistently and the difference stays honest. Summing the ticked rows here in the browser would
 * be faster and would quietly disagree with the dashboard.
 *
 * The reclaim figure is the one place in this product where green is allowed. It is money coming
 * back to the user, and it is the only thing on the screen that qualifies.
 */

/**
 * Long enough that ticking five boxes in a row is one request, short enough that the number feels
 * attached to the click. Below ~150ms this fires per keystroke-equivalent; above ~400ms the
 * figure stops feeling live.
 */
const DEBOUNCE_MS = 250;

export function CancelSimulator({ locale }: { readonly locale: string }): React.ReactNode {
  const [search, setSearch] = React.useState('');
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = React.useState<SimulationResult | null>(null);

  const list = api.subscriptions.list.useQuery({
    statuses: ['active', 'trialing', 'cancel_scheduled'],
    limit: 500,
    sort: 'amount',
    direction: 'desc',
  });

  const simulate = api.analytics.simulate.useMutation({
    onSuccess: (data) => {
      setResult(data);
    },
  });

  // `mutate` is stable across renders, but the effect below has to depend on *something* that
  // identifies the call, so the selection is turned into a sorted key. Depending on the Set
  // itself would refire on every render, and firing a mutation in a render loop is how a live
  // figure becomes a request storm.
  const selectionKey = React.useMemo(() => [...selected].sort().join(','), [selected]);
  const runSimulation = simulate.mutate;

  React.useEffect(() => {
    const ids = selectionKey === '' ? [] : selectionKey.split(',');
    const timer = setTimeout(() => {
      runSimulation({ cancelIds: ids });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [selectionKey, runSimulation]);

  const rows = React.useMemo(() => {
    const items = list.data?.items ?? [];
    const needle = search.trim().toLowerCase();
    if (needle === '') return items;
    return items.filter((entry) => entry.subscription.displayName.toLowerCase().includes(needle));
  }, [list.data, search]);

  function toggle(id: string, next: boolean): void {
    setSelected((previous) => {
      const updated = new Set(previous);
      if (next) updated.add(id);
      else updated.delete(id);
      return updated;
    });
  }

  const unconvertible = result?.unconvertibleIds ?? [];

  return (
    <Panel className="min-w-0">
      <PanelHeader
        eyebrow="Cancel simulator"
        actions={
          selected.size === 0 ? null : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelected(new Set());
              }}
            >
              Clear {selected.size}
            </Button>
          )
        }
      >
        Tick what you would drop. Nothing is cancelled — this only does the arithmetic.
      </PanelHeader>

      <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
        <div
          aria-live="polite"
          className="grid gap-[var(--gap)] rounded-md border border-line bg-ink-700 p-[var(--pad-card)] sm:grid-cols-3"
        >
          <Figure
            label="You commit now"
            amountMinor={result?.beforeMonthlyMinor ?? null}
            secondaryMinor={result?.beforeAnnualMinor ?? null}
            currency={result?.currency ?? null}
            locale={locale}
            tone="outflow"
          />
          <Figure
            label="You would commit"
            amountMinor={result?.afterMonthlyMinor ?? null}
            secondaryMinor={result?.afterAnnualMinor ?? null}
            currency={result?.currency ?? null}
            locale={locale}
            tone="outflow"
          />
          <Figure
            label="You would reclaim"
            amountMinor={result?.reclaimedMonthlyMinor ?? null}
            secondaryMinor={result?.reclaimedAnnualMinor ?? null}
            currency={result?.currency ?? null}
            locale={locale}
            tone="reclaim"
            emphasise
          />
        </div>

        {simulate.error !== null ? (
          <LoadError
            what="the simulation"
            error={simulate.error}
            onRetry={() => {
              runSimulation({ cancelIds: [...selected] });
            }}
          />
        ) : null}

        {unconvertible.length > 0 ? (
          <p className="text-xs text-text-3">
            {unconvertible.length}{' '}
            {unconvertible.length === 1 ? 'subscription is' : 'subscriptions are'} in a currency we
            cannot convert yet, so they are left out of both figures rather than converted at a
            made-up rate.
          </p>
        ) : null}

        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-3"
          />
          <Input
            value={search}
            placeholder="Search"
            aria-label="Search your subscriptions"
            className="pl-8"
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>

        {list.error !== null ? (
          <LoadError
            what="your subscriptions"
            error={list.error}
            retrying={list.isFetching}
            onRetry={() => {
              void list.refetch();
            }}
          />
        ) : list.isPending ? (
          <div className="flex flex-col gap-1.5">
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton key={row} className="h-9 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState>
            {search === ''
              ? 'Nothing is charging you, so there is nothing to simulate.'
              : `Nothing matches “${search}”.`}
          </EmptyState>
        ) : (
          <ul
            aria-label="Subscriptions to drop"
            className="max-h-96 min-w-0 overflow-y-auto rounded-md border border-line"
          >
            {rows.map((entry) => {
              const subscription = entry.subscription;
              const checked = selected.has(subscription.id);
              const inputId = `simulate-${subscription.id}`;

              return (
                <li key={subscription.id}>
                  <label
                    htmlFor={inputId}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 border-b border-line px-[var(--pad-card)] py-2 last:border-b-0',
                      'transition-colors duration-[var(--duration-fast)] ease-standard hover:bg-ink-700',
                      checked && 'bg-ink-600',
                    )}
                  >
                    <Checkbox
                      id={inputId}
                      checked={checked}
                      onCheckedChange={(value) => {
                        toggle(subscription.id, value === true);
                      }}
                    />
                    <MerchantMark
                      name={subscription.displayName}
                      logoUrl={entry.merchantLogo}
                      size="sm"
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'block truncate text-[0.8125rem]',
                          checked ? 'text-text-3 line-through' : 'text-text',
                        )}
                      >
                        {subscription.displayName}
                      </span>
                      <span className="block text-[0.6875rem] text-text-3">
                        {intervalLabel(
                          interval(subscription.intervalUnit, subscription.intervalCount),
                        )}
                      </span>
                    </span>
                    <Money
                      amountMinor={subscription.amountMinor}
                      currency={subscription.currency}
                      tone="outflow"
                      size="sm"
                      locale={locale}
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </PanelBody>
    </Panel>
  );
}

/**
 * One figure in the summary strip.
 *
 * `--reclaim` is passed only by the third one. The tone is a prop rather than derived from the
 * label so that the single sanctioned use of green in this product is visible at the call site,
 * where a reviewer will see it.
 */
function Figure({
  label,
  amountMinor,
  secondaryMinor,
  currency,
  locale,
  tone,
  emphasise = false,
}: {
  readonly label: string;
  readonly amountMinor: number | null;
  readonly secondaryMinor: number | null;
  readonly currency: string | null;
  readonly locale: string;
  readonly tone: 'outflow' | 'reclaim';
  readonly emphasise?: boolean;
}): React.ReactNode {
  return (
    <div className={cn('min-w-0', emphasise && 'sm:border-l sm:border-line sm:pl-[var(--gap-loose)]')}>
      <p className="eyebrow flex items-center gap-1">
        {emphasise ? <Sparkles className="size-3 text-reclaim" aria-hidden /> : null}
        {label}
      </p>

      {amountMinor === null || currency === null ? (
        <Skeleton className="mt-2 h-7 w-24" />
      ) : (
        <>
          <p className="mt-1.5">
            <Money
              amountMinor={amountMinor}
              currency={currency}
              tone={tone}
              size="xl"
              locale={locale}
            />
            <span className="ml-1 text-xs text-text-3">/mo</span>
          </p>
          {secondaryMinor === null ? null : (
            <p className="mt-1">
              <Badge tone={tone === 'reclaim' ? 'reclaim' : 'neutral'} mono>
                <Money
                  amountMinor={secondaryMinor}
                  currency={currency}
                  tone="plain"
                  size="sm"
                  locale={locale}
                  className="text-inherit"
                />
                <span className="ml-0.5">/yr</span>
              </Badge>
            </p>
          )}
        </>
      )}
    </div>
  );
}
