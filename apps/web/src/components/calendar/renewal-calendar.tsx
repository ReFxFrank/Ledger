'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  type PlainDate,
  type SubscriptionStatus,
  addDays,
  addMonths,
  daysInMonth,
  dayOfWeek,
  formatPlainDate,
  interval,
  occurrencesBetween,
  parsePlainDate,
  startOfMonth,
} from '@ledger/core';
import {
  Button,
  Money,
  Panel,
  PanelBody,
  PanelHeader,
  StatusPill,
  cn,
  focusRing,
} from '@ledger/ui';

/**
 * The renewal calendar.
 *
 * Occurrences are projected on the client from each subscription's anchor using the *same*
 * `occurrencesBetween` the horizon procedure calls on the server. That is deliberate: the two
 * views must never disagree about which day a charge lands on, and the only way to guarantee
 * that is one implementation of the date maths. It also means the grid can go backwards through
 * months, which a forward-only horizon endpoint cannot answer.
 *
 * The grid is a real `role="grid"` with roving tabindex, because a month of dates that can only
 * be reached with a pointer is a month of dates half the users cannot reach.
 */

export interface CalendarSubscription {
  readonly id: string;
  readonly displayName: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly intervalUnit: 'day' | 'week' | 'month' | 'year';
  readonly intervalCount: number;
  readonly anchorDate: string;
  readonly status: SubscriptionStatus;
  readonly variableAmount: boolean;
}

export interface RenewalCalendarProps {
  readonly subscriptions: readonly CalendarSubscription[];
  /** The user's today, from the server, so a browser in another timezone cannot disagree. */
  readonly today: PlainDate;
  readonly locale?: string;
}

interface DayCharge {
  readonly subscription: CalendarSubscription;
}

interface DayCell {
  readonly iso: string;
  readonly date: PlainDate;
  readonly inMonth: boolean;
  readonly isToday: boolean;
  readonly charges: readonly DayCharge[];
  /** Totals per currency. Never summed across currencies — that is not a number. */
  readonly totals: readonly { readonly currency: string; readonly amountMinor: number }[];
}

const WEEK_START = 1; // Monday. Renewal weeks read better when the weekend sits at the end.
const ROWS = 6; // Fixed, so the grid does not change height as the user pages through months.

function monthLabel(date: PlainDate, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(date.year, date.month - 1, 1)),
  );
}

function longDate(date: PlainDate, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(date.year, date.month - 1, date.day)));
}

function weekdayNames(locale: string): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  // 2024-01-01 was a Monday, which makes it a convenient origin for a Monday-first header.
  return Array.from({ length: 7 }, (_unused, index) =>
    formatter.format(new Date(Date.UTC(2024, 0, 1 + index))),
  );
}

export function RenewalCalendar({
  subscriptions,
  today,
  locale = 'en-US',
}: RenewalCalendarProps): React.ReactNode {
  const [month, setMonth] = React.useState<PlainDate>(() => startOfMonth(today));
  const [focused, setFocused] = React.useState<string>(() => formatPlainDate(today));
  const [selected, setSelected] = React.useState<string | null>(null);
  const gridRef = React.useRef<HTMLDivElement | null>(null);
  // Only move the DOM focus when the *user* moved the selection, never on the first paint.
  const shouldRestoreFocus = React.useRef(false);
  const gridId = React.useId();

  const cells = React.useMemo(
    () => buildCells(month, today, subscriptions),
    [month, today, subscriptions],
  );

  const monthTotals = React.useMemo(() => {
    const byCurrency = new Map<string, number>();
    for (const cell of cells) {
      if (!cell.inMonth) continue;
      for (const total of cell.totals) {
        byCurrency.set(total.currency, (byCurrency.get(total.currency) ?? 0) + total.amountMinor);
      }
    }
    return [...byCurrency.entries()].map(([currency, amountMinor]) => ({ currency, amountMinor }));
  }, [cells]);

  React.useEffect(() => {
    if (!shouldRestoreFocus.current) return;
    shouldRestoreFocus.current = false;
    const node = gridRef.current?.querySelector<HTMLElement>(`[data-date="${focused}"]`);
    node?.focus();
  }, [focused]);

  /** Keyboard movement: shifts the roving selection and pages the month when it leaves. */
  const moveTo = React.useCallback((date: PlainDate) => {
    shouldRestoreFocus.current = true;
    setFocused(formatPlainDate(date));
    setMonth((current) =>
      current.year === date.year && current.month === date.month ? current : startOfMonth(date),
    );
  }, []);

  /**
   * Pointer movement: pages the month and drags the roving selection along with it.
   *
   * The selection has to follow. It is the grid's only tab stop, and leaving it on a date the
   * new month does not render would make the whole calendar unreachable by keyboard after two
   * clicks of the arrow button — the classic roving-tabindex bug. Focus itself stays on the
   * button that was clicked, which is what a mouse user expects.
   */
  const goToMonth = React.useCallback((target: PlainDate) => {
    setMonth(startOfMonth(target));
    setFocused((current) => {
      const date = parsePlainDate(current);
      if (date.year === target.year && date.month === target.month) return current;
      return formatPlainDate(clampToMonth(startOfMonth(target), date.day));
    });
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const current = parsePlainDate(focused);

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        moveTo(addDays(current, -1));
        return;
      case 'ArrowRight':
        event.preventDefault();
        moveTo(addDays(current, 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveTo(addDays(current, -7));
        return;
      case 'ArrowDown':
        event.preventDefault();
        moveTo(addDays(current, 7));
        return;
      case 'Home': {
        event.preventDefault();
        moveTo(addDays(current, -weekdayOffset(current)));
        return;
      }
      case 'End': {
        event.preventDefault();
        moveTo(addDays(current, 6 - weekdayOffset(current)));
        return;
      }
      case 'PageUp':
        event.preventDefault();
        moveTo(clampToMonth(addMonths(current, -1), current.day));
        return;
      case 'PageDown':
        event.preventDefault();
        moveTo(clampToMonth(addMonths(current, 1), current.day));
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        setSelected(focused);
        return;
      case 'Escape':
        setSelected(null);
        return;
      default:
        return;
    }
  };

  const selectedCell = selected === null ? undefined : cells.find((cell) => cell.iso === selected);
  const weekdays = weekdayNames(locale);
  const localeProp = { locale };

  return (
    <div className="flex flex-col gap-[var(--gap-loose)]">
      <Panel>
        <PanelHeader
          eyebrow="Renewals"
          actions={
            <div className="flex items-center gap-[var(--gap-tight)]">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMonth(startOfMonth(today));
                  setFocused(formatPlainDate(today));
                }}
              >
                Today
              </Button>
              <Button
                size="sm"
                variant="secondary"
                iconOnly
                aria-label="Previous month"
                onClick={() => {
                  goToMonth(addMonths(month, -1));
                }}
              >
                <Chevron direction="left" />
              </Button>
              <Button
                size="sm"
                variant="secondary"
                iconOnly
                aria-label="Next month"
                onClick={() => {
                  goToMonth(addMonths(month, 1));
                }}
              >
                <Chevron direction="right" />
              </Button>
            </div>
          }
        >
          <span className="flex flex-wrap items-baseline gap-x-[var(--gap)] gap-y-1">
            <span aria-live="polite">{monthLabel(month, locale)}</span>
            {monthTotals.length === 0 ? null : (
              <span className="flex items-baseline gap-1.5">
                <span className="eyebrow">Due this month</span>
                {monthTotals.map((total) => (
                  <Money
                    key={total.currency}
                    amountMinor={total.amountMinor}
                    currency={total.currency}
                    tone="outflow"
                    size="md"
                    {...localeProp}
                  />
                ))}
              </span>
            )}
          </span>
        </PanelHeader>

        <PanelBody className="p-[var(--gap-tight)]">
          <div className="grid grid-cols-7 gap-px pb-1">
            {weekdays.map((name) => (
              <div key={name} className="eyebrow px-1 py-1 text-center">
                {name}
              </div>
            ))}
          </div>

          {/*
            Each week is its own seven-column grid rather than one 42-cell grid with
            `display: contents` rows. `display: contents` has a history of dropping the element
            — and therefore its ARIA role — out of the accessibility tree, which would leave a
            grid with no rows in it. Equal fractions per row keep the columns aligned anyway.
          */}
          <div
            ref={gridRef}
            role="grid"
            id={gridId}
            aria-label={`Renewals in ${monthLabel(month, locale)}`}
            aria-rowcount={ROWS}
            aria-colcount={7}
            className="flex flex-col gap-px overflow-hidden rounded-md bg-line"
            onKeyDown={handleKeyDown}
          >
            {Array.from({ length: ROWS }, (_unused, row) => (
              <div key={row} role="row" className="grid grid-cols-7 gap-px">
                {cells.slice(row * 7, row * 7 + 7).map((cell) => (
                  <DayButton
                    key={cell.iso}
                    cell={cell}
                    locale={locale}
                    isFocusTarget={cell.iso === focused}
                    isSelected={cell.iso === selected}
                    onSelect={() => {
                      shouldRestoreFocus.current = false;
                      setFocused(cell.iso);
                      setSelected(cell.iso);
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </PanelBody>
      </Panel>

      {selectedCell === undefined ? (
        <p className="text-xs text-text-3">
          Pick a day to see what renews on it. Arrow keys move, Enter opens.
        </p>
      ) : (
        <DayDetail cell={selectedCell} locale={locale} onClose={() => { setSelected(null); }} />
      )}
    </div>
  );
}

// ── day cell ───────────────────────────────────────────────────────────────────────────

function DayButton({
  cell,
  locale,
  isFocusTarget,
  isSelected,
  onSelect,
}: {
  readonly cell: DayCell;
  readonly locale: string;
  readonly isFocusTarget: boolean;
  readonly isSelected: boolean;
  readonly onSelect: () => void;
}): React.ReactNode {
  const count = cell.charges.length;
  const extraCurrencies = Math.max(0, cell.totals.length - 1);
  const primary = cell.totals[0];

  return (
    <div role="gridcell" aria-selected={isSelected} className="min-w-0">
      <button
        type="button"
        data-date={cell.iso}
        // Roving tabindex: the grid is one tab stop and the arrow keys do the rest.
        tabIndex={isFocusTarget ? 0 : -1}
        onClick={onSelect}
        aria-label={`${longDate(cell.date, locale)}. ${
          count === 0
            ? 'No renewals'
            : count === 1
              ? '1 renewal'
              : `${String(count)} renewals`
        }`}
        className={cn(
          'flex h-full min-h-[62px] w-full flex-col items-stretch gap-1 p-1.5 text-left sm:min-h-[76px] sm:p-2',
          'transition-[background-color,box-shadow] duration-[var(--duration-fast)] ease-standard',
          focusRing,
          cell.inMonth ? 'bg-ink-800' : 'bg-ink-900',
          isSelected ? 'bg-ink-500' : 'hover:bg-ink-700',
        )}
      >
        <span className="flex items-center justify-between gap-1">
          <span
            className={cn(
              'font-mono text-[0.6875rem] leading-none tabular-nums',
              cell.inMonth ? 'text-text-2' : 'text-text-3',
              cell.isToday &&
                'rounded-sm bg-control px-1 py-0.5 font-medium text-ink-900',
            )}
          >
            {cell.date.day}
          </span>
          {count > 0 ? (
            <span className="font-mono text-[0.625rem] leading-none text-text-3">{count}</span>
          ) : null}
        </span>

        {primary === undefined ? null : (
          <span className="mt-auto flex flex-wrap items-baseline gap-1">
            <Money
              amountMinor={primary.amountMinor}
              currency={primary.currency}
              tone="outflow"
              size="sm"
              locale={locale}
              className="text-[0.6875rem] leading-none"
            />
            {extraCurrencies > 0 ? (
              <span className="font-mono text-[0.625rem] leading-none text-text-3">
                +{extraCurrencies}
              </span>
            ) : null}
          </span>
        )}
      </button>
    </div>
  );
}

// ── the opened day ─────────────────────────────────────────────────────────────────────

function DayDetail({
  cell,
  locale,
  onClose,
}: {
  readonly cell: DayCell;
  readonly locale: string;
  readonly onClose: () => void;
}): React.ReactNode {
  return (
    <Panel>
      <PanelHeader
        eyebrow={longDate(cell.date, locale)}
        actions={
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        }
      >
        {cell.charges.length === 0 ? (
          'Nothing renews on this day.'
        ) : (
          <span className="flex flex-wrap items-baseline gap-x-[var(--gap)]">
            <span>
              {cell.charges.length === 1 ? '1 renewal' : `${String(cell.charges.length)} renewals`}
            </span>
            {cell.totals.map((total) => (
              <Money
                key={total.currency}
                amountMinor={total.amountMinor}
                currency={total.currency}
                tone="outflow"
                size="md"
                locale={locale}
              />
            ))}
          </span>
        )}
      </PanelHeader>

      {cell.charges.length === 0 ? null : (
        <PanelBody className="p-[var(--gap-tight)]">
          <ul className="flex flex-col">
            {cell.charges.map(({ subscription }) => (
              <li key={subscription.id}>
                <Link
                  href={`/subscriptions/${subscription.id}`}
                  className="flex items-center justify-between gap-[var(--gap)] rounded-md px-[var(--gap-loose)] py-2.5 transition-[background-color] duration-[var(--duration-fast)] ease-standard hover:bg-ink-700"
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-[var(--gap-tight)]">
                    <span className="truncate text-sm text-text">{subscription.displayName}</span>
                    <StatusPill status={subscription.status} dot={false} />
                    {subscription.variableAmount ? (
                      <span className="eyebrow">Amount varies</span>
                    ) : null}
                  </span>
                  <Money
                    amountMinor={subscription.amountMinor}
                    currency={subscription.currency}
                    tone="outflow"
                    size="md"
                    locale={locale}
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

function Chevron({ direction }: { readonly direction: 'left' | 'right' }): React.ReactNode {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden focusable="false">
      <path
        d={direction === 'left' ? 'M10 3 L5 8 L10 13' : 'M6 3 L11 8 L6 13'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── projection ─────────────────────────────────────────────────────────────────────────

/** How far into its week a date sits, with the week starting on `WEEK_START`. */
function weekdayOffset(date: PlainDate): number {
  return (((dayOfWeek(date) - WEEK_START) % 7) + 7) % 7;
}

/** Keeps a day-of-month move sane across a short month: Mar 31 → PageUp → Feb 28. */
function clampToMonth(date: PlainDate, preferredDay: number): PlainDate {
  return { ...date, day: Math.min(preferredDay, daysInMonth(date.year, date.month)) };
}

function buildCells(
  month: PlainDate,
  today: PlainDate,
  subscriptions: readonly CalendarSubscription[],
): DayCell[] {
  const first = startOfMonth(month);
  const gridStart = addDays(first, -weekdayOffset(first));
  const gridEnd = addDays(gridStart, ROWS * 7 - 1);
  const todayIso = formatPlainDate(today);

  const byDay = new Map<string, DayCharge[]>();
  for (const subscription of subscriptions) {
    let occurrences: PlainDate[];
    try {
      occurrences = occurrencesBetween(
        parsePlainDate(subscription.anchorDate),
        interval(subscription.intervalUnit, subscription.intervalCount),
        gridStart,
        gridEnd,
      );
    } catch {
      // A malformed anchor or interval is one subscription's problem, not the calendar's.
      // It stays out of the grid and stays visible in the subscriptions table.
      continue;
    }

    for (const occurrenceDate of occurrences) {
      const iso = formatPlainDate(occurrenceDate);
      const bucket = byDay.get(iso);
      if (bucket === undefined) byDay.set(iso, [{ subscription }]);
      else bucket.push({ subscription });
    }
  }

  return Array.from({ length: ROWS * 7 }, (_unused, index) => {
    const date = addDays(gridStart, index);
    const iso = formatPlainDate(date);
    const charges = byDay.get(iso) ?? [];

    const byCurrency = new Map<string, number>();
    for (const { subscription } of charges) {
      byCurrency.set(
        subscription.currency,
        (byCurrency.get(subscription.currency) ?? 0) + subscription.amountMinor,
      );
    }

    return {
      iso,
      date,
      inMonth: date.month === month.month && date.year === month.year,
      isToday: iso === todayIso,
      charges: [...charges].sort((a, b) => b.subscription.amountMinor - a.subscription.amountMinor),
      // Biggest currency block first, so the cell shows the figure that dominates the day.
      totals: [...byCurrency.entries()]
        .map(([currency, amountMinor]) => ({ currency, amountMinor }))
        .sort((a, b) => b.amountMinor - a.amountMinor),
    };
  });
}
