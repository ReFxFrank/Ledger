'use client';

/**
 * The subscriptions table — the screen a user lives in.
 *
 * Three decisions drive the shape of this file:
 *
 *  1. **It is a CSS grid, not a `<table>`.** Virtualised rows have to be absolutely positioned,
 *     and absolutely positioned `<tr>`s fight the table layout algorithm forever. One shared
 *     column template gives the same alignment guarantee — the only thing the money column
 *     actually needs — and the ARIA grid roles give assistive technology the same structure.
 *  2. **Keyboard operation is the primary interface, not a fallback.** Roving tabindex on the
 *     rows: arrows move, Space selects, Enter opens, `/` searches, Escape clears. Only the row
 *     that currently has focus puts its own controls in the tab order, so Tab does not walk
 *     through 400 checkboxes on the way to the bulk bar.
 *  3. **Optimistic edits with a real rollback.** An inline rename writes to the query cache
 *     first and restores the exact previous cache entry if the mutation fails. Anything less
 *     leaves the user looking at a value that was never saved.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  type Column,
  type ColumnFiltersState,
  type ExpandedState,
  type FilterFn,
  type GroupingState,
  type Row,
  type RowData,
  type RowSelectionState,
  type SortingState,
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getGroupedRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Link2, Plus, Wallet } from 'lucide-react';
import {
  BILLING_CHANNELS,
  BILLING_CHANNEL_LABELS,
  CATEGORIES,
  CATEGORY_LABELS,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_LABELS,
  type BillingChannel,
  type Category,
  type PlainDate,
  type SubscriptionStatus,
  approximateDays,
  formatPlainDate,
  fromInstant,
  interval,
  intervalLabel,
  money,
  parseMoney,
  toDecimalString,
} from '@ledger/core';
import {
  Button,
  Checkbox,
  EmptyState,
  Money,
  Panel,
  Skeleton,
  StatusPill,
  cn,
  focusRing,
  toast,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import { daysUntil, formatDay, formatRelativeDay, sumIfSingleCurrency, todayIn } from '~/lib/format';
import {
  EMPTY_SNAPSHOT,
  type SavedView,
  type ViewSnapshot,
  useSubscriptionViews,
} from '~/lib/stores/subscription-views';
import { usePendingIntent } from '~/lib/stores/pending-intent';
import { BulkActionBar } from './bulk-bar';
import { OptionFilter, TextFilter } from './column-filters';
import { SubscriptionEditor } from './editor';
import { SubscriptionsToolbar } from './toolbar';
import type { SubscriptionRow } from './types';

/**
 * Column widths travel with the column definition, so the header and the rows are built from the
 * same numbers and cannot drift apart when a column is hidden.
 */
declare module '@tanstack/react-table' {
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars -- the augmented interface must restate the library's generics */
  interface ColumnMeta<TData extends RowData, TValue> {
    readonly width?: string;
    readonly align?: 'end';
    readonly label?: string;
  }
}

/** Fixed row height, so the virtualiser never has to measure. Dense register, §6.5. */
const ROW_HEIGHT = 40;

/**
 * The server caps a page at 500. Past that this wants `useInfiniteQuery` wired into the
 * virtualiser's scroll position; at 500 rows the virtualiser is already doing the work that
 * keeps the screen responsive.
 */
const PAGE_LIMIT = 500;

/** Matches a scalar cell against a set of allowed values. TanStack has no built-in for that. */
const inSet: FilterFn<SubscriptionRow> = (row, columnId, filterValue) => {
  const allowed = toStringArray(filterValue);
  if (allowed.length === 0) return true;
  const value = row.getValue(columnId);
  return typeof value === 'string' && allowed.includes(value);
};

function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value as readonly unknown[]) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

// ── per-render context ───────────────────────────────────────────────────────────────────

type EditTarget = { readonly rowId: string; readonly column: 'name' | 'amount' } | null;

interface RowUi {
  readonly locale: string;
  readonly timezone: string;
  readonly today: PlainDate;
  readonly focusedRowId: string | null;
  readonly editing: EditTarget;
  readonly startEdit: (rowId: string, column: 'name' | 'amount') => void;
  readonly cancelEdit: () => void;
  readonly commitName: (row: SubscriptionRow, value: string) => void;
  readonly commitAmount: (row: SubscriptionRow, value: string) => void;
}

/**
 * Cells read the focus and edit state from context rather than from closed-over props.
 *
 * The alternative is putting `focusedIndex` in the dependencies of the column definitions, which
 * rebuilds every column def on every arrow keypress — TanStack survives it, but it throws away
 * the table's memoised row model on a keystroke, which is exactly what a virtualised table
 * cannot afford.
 */
const RowUiContext = React.createContext<RowUi | null>(null);

function useRowUi(): RowUi {
  const value = React.useContext(RowUiContext);
  if (value === null) throw new Error('Subscription cells must render inside the table.');
  return value;
}

// ── columns ──────────────────────────────────────────────────────────────────────────────

const columnHelper = createColumnHelper<SubscriptionRow>();

const columns = [
  columnHelper.display({
    id: 'select',
    meta: { width: '2.25rem', label: 'Select' },
    enableSorting: false,
    enableGrouping: false,
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? 'indeterminate' : false
        }
        onCheckedChange={(value) => {
          table.toggleAllRowsSelected(value === true);
        }}
        aria-label="Select all subscriptions"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        // Not a tab stop: Space on the focused row is the keyboard path, and 400 checkboxes in
        // the tab order would make reaching the bulk bar a chore rather than a shortcut.
        tabIndex={-1}
        onCheckedChange={(value) => {
          row.toggleSelected(value === true);
        }}
        aria-label={`Select ${row.original.displayName}`}
      />
    ),
  }),

  columnHelper.accessor('displayName', {
    id: 'name',
    meta: { width: 'minmax(12rem, 2.2fr)', label: 'Name' },
    filterFn: 'includesString',
    enableGrouping: false,
    cell: ({ row }) => <NameCell row={row.original} />,
  }),

  // Sorted on raw minor units. Across currencies that is a rough ordering rather than a true
  // one — there is no FX rate table yet (see the TODO in routers/dashboard.ts) and inventing a
  // rate to sort by would be a wrong answer wearing the clothes of a right one.
  columnHelper.accessor('amountMinor', {
    id: 'amount',
    meta: { width: '7.5rem', align: 'end', label: 'Amount' },
    enableColumnFilter: false,
    enableGrouping: false,
    cell: ({ row }) => <AmountCell row={row.original} />,
  }),

  columnHelper.accessor((row) => row.intervalUnit, {
    id: 'cadence',
    meta: { width: '7.5rem', label: 'Cadence' },
    filterFn: inSet,
    enableGrouping: false,
    sortingFn: (a, b) =>
      approximateDays(interval(a.original.intervalUnit, a.original.intervalCount)) -
      approximateDays(interval(b.original.intervalUnit, b.original.intervalCount)),
    cell: ({ row }) => (
      <span className="truncate text-text-2">
        {intervalLabel(interval(row.original.intervalUnit, row.original.intervalCount))}
      </span>
    ),
  }),

  columnHelper.accessor((row) => row.nextRenewalAt?.getTime() ?? null, {
    id: 'nextCharge',
    meta: { width: '11rem', label: 'Next charge' },
    enableColumnFilter: false,
    enableGrouping: false,
    // Rows with no projection sink under an ascending sort. TanStack negates the comparator for
    // descending, so they float on the way back — accepted, and better than pretending a paused
    // subscription has a next charge just to keep it pinned to the bottom.
    sortingFn: (a, b) => {
      const left = a.original.nextRenewalAt?.getTime() ?? null;
      const right = b.original.nextRenewalAt?.getTime() ?? null;
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return left - right;
    },
    cell: ({ row }) => <NextChargeCell row={row.original} />,
  }),

  columnHelper.accessor('category', {
    id: 'category',
    meta: { width: '9rem', label: 'Category' },
    filterFn: inSet,
    cell: ({ row }) => <span className="truncate text-text-2">{CATEGORY_LABELS[row.original.category]}</span>,
  }),

  columnHelper.accessor('billingChannel', {
    id: 'channel',
    meta: { width: '9rem', label: 'Channel' },
    filterFn: inSet,
    cell: ({ row }) => (
      <span className="truncate text-text-2">{BILLING_CHANNEL_LABELS[row.original.billingChannel]}</span>
    ),
  }),

  columnHelper.accessor('status', {
    id: 'status',
    meta: { width: '7rem', label: 'Status' },
    filterFn: inSet,
    cell: ({ row }) => <StatusCell row={row.original} />,
  }),

  // Hidden by default. It exists so the user can group by payment method without spending a
  // column on a label that repeats down the whole table.
  columnHelper.accessor('paymentMethodLabel', {
    id: 'paymentMethod',
    meta: { width: '10rem', label: 'Payment method' },
    filterFn: inSet,
    cell: ({ getValue }) => <span className="truncate text-text-2">{getValue()}</span>,
  }),
];

const FILTER_LABELS: Readonly<Record<string, string>> = {
  cadence: 'Cadence',
  category: 'Category',
  channel: 'Billing channel',
  status: 'Status',
  paymentMethod: 'Payment method',
};

const OPTION_SETS: Readonly<Record<string, readonly { readonly value: string; readonly label: string }[]>> = {
  cadence: [
    { value: 'day', label: 'Daily' },
    { value: 'week', label: 'Weekly' },
    { value: 'month', label: 'Monthly' },
    { value: 'year', label: 'Annual' },
  ],
  category: CATEGORIES.map((value: Category) => ({ value, label: CATEGORY_LABELS[value] })),
  channel: BILLING_CHANNELS.map((value: BillingChannel) => ({
    value,
    label: BILLING_CHANNEL_LABELS[value],
  })),
  status: SUBSCRIPTION_STATUSES.map((value: SubscriptionStatus) => ({
    value,
    label: SUBSCRIPTION_STATUS_LABELS[value],
  })),
};

// ── the table ────────────────────────────────────────────────────────────────────────────

export function SubscriptionsTable(): React.ReactElement {
  const router = useRouter();
  const utils = api.useUtils();
  const setActiveViewId = useSubscriptionViews((state) => state.setActiveViewId);

  const [includeArchived, setIncludeArchived] = React.useState(EMPTY_SNAPSHOT.includeArchived);
  const [search, setSearch] = React.useState(EMPTY_SNAPSHOT.search);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [sorting, setSorting] = React.useState<SortingState>(() =>
    EMPTY_SNAPSHOT.sorting.map((sort) => ({ id: sort.id, desc: sort.desc })),
  );
  const [grouping, setGrouping] = React.useState<GroupingState>([]);
  const [expanded, setExpanded] = React.useState<ExpandedState>(true);
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});

  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const [editing, setEditing] = React.useState<EditTarget>(null);
  const [editorFor, setEditorFor] = React.useState<{ readonly id: string | null } | null>(null);

  const searchRef = React.useRef<HTMLInputElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  /** Move DOM focus only when the user asked for it, or a background refetch steals the caret. */
  const wantsRowFocus = React.useRef(false);

  /**
   * "Add a subscription" from the command palette lands here: the palette cannot open a form that
   * is this component's own state, so it leaves an intent and navigates. Read once and cleared,
   * so a later remount — a back navigation, a refetch — does not reopen a form nobody asked for
   * a second time.
   */
  const takeNewSubscription = usePendingIntent((state) => state.takeNewSubscription);
  React.useEffect(() => {
    if (takeNewSubscription()) setEditorFor({ id: null });
  }, [takeNewSubscription]);

  // ── data ─────────────────────────────────────────────────────────────────────────────
  const listInput = React.useMemo(
    () => ({ includeArchived, limit: PAGE_LIMIT, sort: 'nextRenewal' as const, direction: 'asc' as const }),
    [includeArchived],
  );

  const me = api.me.current.useQuery();
  const list = api.subscriptions.list.useQuery(listInput);
  const paymentMethods = api.paymentMethods.list.useQuery({ includeArchived: true });

  const locale = me.data?.locale ?? 'en-GB';
  const timezone = me.data?.timezone ?? 'UTC';
  const today = React.useMemo(() => todayIn(timezone), [timezone]);

  const rows = React.useMemo<SubscriptionRow[]>(() => {
    const items = list.data?.items ?? [];
    const labels = new Map((paymentMethods.data ?? []).map((method) => [method.id, method.label]));

    return items.map((entry) => ({
      id: entry.subscription.id,
      displayName: entry.subscription.displayName,
      merchantName: entry.merchantName,
      merchantLogo: entry.merchantLogo,
      amountMinor: entry.subscription.amountMinor,
      currency: entry.subscription.currency,
      intervalUnit: entry.subscription.intervalUnit,
      intervalCount: entry.subscription.intervalCount,
      anchorDate: entry.subscription.anchorDate,
      nextRenewalAt: entry.subscription.nextRenewalAt,
      trialEndsAt: entry.subscription.trialEndsAt,
      cancelByAt: entry.subscription.cancelByAt,
      category: entry.subscription.category,
      billingChannel: entry.subscription.billingChannel,
      status: entry.subscription.status,
      paymentMethodId: entry.subscription.paymentMethodId,
      // Grouping needs a value for every row, and "unknown" reads like a data problem rather
      // than the ordinary case of a subscription nobody has told us the card for.
      paymentMethodLabel:
        entry.subscription.paymentMethodId === null
          ? 'No payment method'
          : (labels.get(entry.subscription.paymentMethodId) ?? 'No payment method'),
      variableAmount: entry.subscription.variableAmount,
      archived: entry.subscription.archivedAt !== null,
      tags: entry.subscription.tags,
    }));
  }, [list.data, paymentMethods.data]);

  // ── optimistic inline edit ───────────────────────────────────────────────────────────
  const update = api.subscriptions.update.useMutation({
    onMutate: async (variables) => {
      // Cancel in-flight refetches first: one landing mid-edit overwrites the optimistic value
      // with the server's stale one, and the row visibly flickers back to the old number.
      await utils.subscriptions.list.cancel(listInput);
      const previous = utils.subscriptions.list.getData(listInput);

      utils.subscriptions.list.setData(listInput, (old) => {
        if (old === undefined) return old;
        return {
          ...old,
          items: old.items.map((entry) =>
            entry.subscription.id === variables.id
              ? {
                  ...entry,
                  subscription: {
                    ...entry.subscription,
                    ...(variables.patch.displayName === undefined
                      ? {}
                      : { displayName: variables.patch.displayName }),
                    ...(variables.patch.amountMinor === undefined
                      ? {}
                      : { amountMinor: variables.patch.amountMinor }),
                  },
                }
              : entry,
          ),
        };
      });

      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous !== undefined) {
        utils.subscriptions.list.setData(listInput, context.previous);
      }
      toast.error('That edit did not save.', { description: error.message });
    },
    onSettled: async () => {
      await utils.subscriptions.list.invalidate();
      await utils.dashboard.totals.invalidate();
    },
  });

  const endEdit = React.useCallback(() => {
    // Hand focus back to the row the user was editing — losing it to `<body>` after Enter is the
    // fastest way to make a keyboard-driven table feel broken.
    wantsRowFocus.current = true;
    setEditing(null);
  }, []);

  const commitName = React.useCallback(
    (row: SubscriptionRow, raw: string) => {
      endEdit();
      const displayName = raw.trim();
      if (displayName === '' || displayName === row.displayName) return;
      update.mutate({ id: row.id, patch: { displayName } });
    },
    [endEdit, update],
  );

  const commitAmount = React.useCallback(
    (row: SubscriptionRow, raw: string) => {
      endEdit();
      if (raw.trim() === '') return;
      try {
        // parseMoney splits on the separator and parses each side as an integer, so "12,99" and
        // "12.99" both land on 1299 minor units and neither ever exists as a float.
        const parsed = parseMoney(raw, row.currency);
        if (parsed.amountMinor === row.amountMinor) return;
        update.mutate({ id: row.id, patch: { amountMinor: parsed.amountMinor } });
      } catch {
        toast.error(`Could not read an amount from "${raw}".`);
      }
    },
    [endEdit, update],
  );

  // ── table instance ───────────────────────────────────────────────────────────────────
  const table = useReactTable({
    data: rows,
    columns,
    state: { columnFilters, sorting, grouping, expanded, rowSelection, globalFilter: search },
    initialState: { columnVisibility: { paymentMethod: false } },
    getRowId: (row) => row.id,
    enableRowSelection: true,
    globalFilterFn: 'includesString',
    onColumnFiltersChange: (updater) => {
      setColumnFilters(updater);
      setActiveViewId(null);
    },
    onSortingChange: (updater) => {
      setSorting(updater);
      setActiveViewId(null);
    },
    onGroupingChange: setGrouping,
    onExpandedChange: setExpanded,
    onRowSelectionChange: setRowSelection,
    onGlobalFilterChange: setSearch,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  const visibleRows = table.getRowModel().rows;
  const leafColumns = table.getVisibleLeafColumns();
  const gridTemplate = leafColumns
    .map((column) => column.columnDef.meta?.width ?? 'minmax(6rem, 1fr)')
    .join(' ');

  const selectedIds = table
    .getSelectedRowModel()
    .flatRows.filter((row) => !row.getIsGrouped())
    .map((row) => row.original.id);

  const leafCount = visibleRows.filter((row) => !row.getIsGrouped()).length;

  // ── virtualisation ───────────────────────────────────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => visibleRows[index]?.id ?? index,
  });

  // ── keyboard ─────────────────────────────────────────────────────────────────────────
  const moveFocus = React.useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(next, visibleRows.length - 1));
      wantsRowFocus.current = true;
      setFocusedIndex(clamped);
      virtualizer.scrollToIndex(clamped, { align: 'auto' });
    },
    [virtualizer, visibleRows.length],
  );

  React.useEffect(() => {
    if (!wantsRowFocus.current || editing !== null) return undefined;
    // The row may not exist in the DOM yet — the virtualiser has only just been told to scroll
    // to it. One frame is enough for it to be rendered and focusable.
    //
    // Looked up from the DOM rather than from a ref map keyed by index: virtualised rows are
    // recycled, and a stale ref cleanup running after a fresh row registers under the same
    // index is a focus that silently goes nowhere.
    const frame = requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-row-index="${String(focusedIndex)}"]`)
        ?.focus();
      wantsRowFocus.current = false;
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [editing, focusedIndex, visibleRows.length]);

  /** `/` and Escape are document-level: they work wherever the user's attention happens to be. */
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target;
      const inField =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (event.key === '/' && !inField && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }

      // Escape belongs to whatever layer is on top. A dialog or a filter popover gets it first;
      // clearing the selection out from under a user who was only closing a menu is a surprise.
      if (event.key === 'Escape' && !inField && document.querySelector('[role="dialog"]') === null) {
        setRowSelection({});
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  function onGridKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (editing !== null) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(focusedIndex + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(focusedIndex - 1);
        return;
      case 'Home':
        event.preventDefault();
        moveFocus(0);
        return;
      case 'End':
        event.preventDefault();
        moveFocus(visibleRows.length - 1);
        return;
      case 'PageDown':
        event.preventDefault();
        moveFocus(focusedIndex + 10);
        return;
      case 'PageUp':
        event.preventDefault();
        moveFocus(focusedIndex - 10);
        return;
      default:
        break;
    }

    const row = visibleRows[focusedIndex];
    if (row === undefined) return;

    if (event.key === ' ') {
      event.preventDefault();
      if (row.getIsGrouped()) row.toggleExpanded();
      else row.toggleSelected(!row.getIsSelected());
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (row.getIsGrouped()) row.toggleExpanded();
      else router.push(`/subscriptions/${row.original.id}`);
    }
  }

  // ── saved views ──────────────────────────────────────────────────────────────────────
  const snapshot: ViewSnapshot = {
    search,
    filters: columnFilters.map((filter) => ({
      id: filter.id,
      value: typeof filter.value === 'string' ? filter.value : toStringArray(filter.value),
    })),
    sorting: sorting.map((sort) => ({ id: sort.id, desc: sort.desc })),
    grouping: [...grouping],
    includeArchived,
  };

  function applyView(view: SavedView): void {
    setSearch(view.search);
    setColumnFilters(view.filters.map((filter) => ({ id: filter.id, value: filter.value })));
    setSorting(view.sorting.map((sort) => ({ id: sort.id, desc: sort.desc })));
    setGrouping([...view.grouping]);
    setIncludeArchived(view.includeArchived);
    setActiveViewId(view.id);
  }

  function clearFilters(): void {
    setColumnFilters([]);
    setSearch('');
    setActiveViewId(null);
  }

  const activeFilterCount = columnFilters.length + (search === '' ? 0 : 1);

  const rowUi: RowUi = {
    locale,
    timezone,
    today,
    focusedRowId: visibleRows[focusedIndex]?.id ?? null,
    editing,
    startEdit: (rowId, column) => {
      setEditing({ rowId, column });
    },
    cancelEdit: endEdit,
    commitName,
    commitAmount,
  };

  return (
    <RowUiContext.Provider value={rowUi}>
      <Panel className="flex min-h-0 flex-col overflow-hidden">
        <div className="border-b border-line px-[var(--pad-panel)] py-[var(--gap-loose)]">
          <SubscriptionsToolbar
            searchRef={searchRef}
            search={search}
            onSearchChange={(value) => {
              setSearch(value);
              setActiveViewId(null);
            }}
            grouping={grouping}
            onGroupingChange={(value) => {
              setGrouping([...value]);
            }}
            includeArchived={includeArchived}
            onIncludeArchivedChange={setIncludeArchived}
            activeFilterCount={activeFilterCount}
            onClearFilters={clearFilters}
            snapshot={snapshot}
            onApplyView={applyView}
            onAddSubscription={() => {
              setEditorFor({ id: null });
            }}
            shownCount={leafCount}
            totalCount={rows.length}
          />
        </div>

        {list.isPending ? (
          <div className="flex flex-col gap-2 p-[var(--pad-panel)]">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Wallet />}
            actions={
              <>
                <Button size="sm" variant="secondary" asChild>
                  <Link href="/connections">
                    <Link2 className="size-3.5" aria-hidden />
                    Connect an account
                  </Link>
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    setEditorFor({ id: null });
                  }}
                >
                  <Plus className="size-3.5" aria-hidden />
                  Add a subscription
                </Button>
              </>
            }
          >
            Nothing tracked yet. Connect an account or add a subscription manually.
          </EmptyState>
        ) : (
          <>
            {/*
              One scroll container for both axes. At 375px the grid is wider than the viewport and
              scrolls sideways inside the panel; the page itself never scrolls horizontally.
            */}
            <div
              ref={scrollRef}
              className={cn('overflow-auto', visibleRows.length > 0 && 'min-h-[16rem] grow')}
              style={
                visibleRows.length > 0
                  ? { height: 'clamp(20rem, calc(100dvh - 17rem), 46rem)' }
                  : undefined
              }
            >
              {/*
                One `role="grid"` wrapping both rowgroups. The header has to live inside it — a
                `columnheader` outside a grid is a role with nothing to describe, and screen
                readers stop announcing the column when it moves.
              */}
              <div
                role="grid"
                aria-label="Subscriptions"
                aria-rowcount={visibleRows.length + 1}
                tabIndex={-1}
                onKeyDown={onGridKeyDown}
                className="min-w-[62rem]"
              >
                <div
                  role="row"
                  aria-rowindex={1}
                  className="sticky top-0 z-10 grid items-center gap-[var(--gap-tight)] border-b border-line bg-ink-800 px-[var(--pad-card)] py-2"
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  {table.getHeaderGroups()[0]?.headers.map((header) => {
                    const column = header.column;
                    const meta = column.columnDef.meta;
                    const sorted = column.getIsSorted();

                    return (
                      <div
                        key={header.id}
                        role="columnheader"
                        aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                        className={cn('flex min-w-0 items-center gap-1', meta?.align === 'end' && 'justify-end')}
                      >
                        {header.id === 'select' ? (
                          flexRender(column.columnDef.header, header.getContext())
                        ) : (
                          <>
                            {column.getCanSort() ? (
                              <button
                                type="button"
                                onClick={column.getToggleSortingHandler()}
                                className={cn(
                                  'eyebrow flex min-w-0 items-center gap-1 rounded-sm px-0.5 py-0.5',
                                  'transition-colors duration-[var(--duration-fast)] ease-standard hover:text-text',
                                  sorted !== false && 'text-control-2',
                                  focusRing,
                                )}
                              >
                                <span className="truncate">{meta?.label ?? column.id}</span>
                                {sorted === 'asc' ? <ArrowUp className="size-3" aria-hidden /> : null}
                                {sorted === 'desc' ? <ArrowDown className="size-3" aria-hidden /> : null}
                              </button>
                            ) : (
                              <span className="eyebrow truncate">{meta?.label ?? column.id}</span>
                            )}
                            <ColumnFilterControl column={column} />
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div
                  role="rowgroup"
                  className="relative"
                  style={{ height: `${String(virtualizer.getTotalSize())}px` }}
                >
                  {virtualizer.getVirtualItems().map((item) => {
                    const row = visibleRows[item.index];
                    if (row === undefined) return null;
                    const grouped = row.getIsGrouped();

                    return (
                      <div
                        key={item.key}
                        data-row-index={item.index}
                        role="row"
                        // +2: the header occupies row 1, and `aria-rowindex` is 1-based.
                        aria-rowindex={item.index + 2}
                        aria-selected={grouped ? undefined : row.getIsSelected()}
                        tabIndex={item.index === focusedIndex ? 0 : -1}
                        onFocus={() => {
                          setFocusedIndex(item.index);
                        }}
                        onClick={() => {
                          wantsRowFocus.current = false;
                          setFocusedIndex(item.index);
                        }}
                        onDoubleClick={() => {
                          if (!grouped) router.push(`/subscriptions/${row.original.id}`);
                        }}
                        className={cn(
                          'absolute inset-x-0 top-0 grid items-center gap-[var(--gap-tight)] border-b border-line px-[var(--pad-card)] text-[0.8125rem]',
                          'transition-colors duration-[var(--duration-fast)] ease-standard',
                          focusRing,
                          grouped
                            ? 'bg-ink-800'
                            : cn(
                                'hover:bg-ink-700',
                                row.getIsSelected() && 'bg-ink-500',
                                row.original.archived && 'opacity-60',
                              ),
                        )}
                        style={{
                          height: `${String(ROW_HEIGHT)}px`,
                          transform: `translateY(${String(item.start)}px)`,
                          ...(grouped ? {} : { gridTemplateColumns: gridTemplate }),
                        }}
                      >
                        {grouped ? (
                          <GroupHeaderRow row={row} locale={locale} />
                        ) : (
                          row.getVisibleCells().map((cell) => (
                            <div
                              key={cell.id}
                              role="gridcell"
                              className={cn(
                                'flex min-w-0 items-center',
                                cell.column.columnDef.meta?.align === 'end' && 'justify-end',
                              )}
                            >
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </div>
                          ))
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {visibleRows.length === 0 ? (
              <EmptyState
                actions={
                  <Button size="sm" variant="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              >
                Nothing matches these filters.
              </EmptyState>
            ) : null}

            {selectedIds.length > 0 ? (
              <BulkActionBar
                ids={selectedIds}
                onClearSelection={() => {
                  setRowSelection({});
                }}
              />
            ) : null}
          </>
        )}

        {editorFor === null ? null : (
          <SubscriptionEditor
            open
            subscriptionId={editorFor.id}
            onOpenChange={(next) => {
              if (!next) setEditorFor(null);
            }}
          />
        )}
      </Panel>
    </RowUiContext.Provider>
  );
}

// ── header filters ───────────────────────────────────────────────────────────────────────

function ColumnFilterControl({
  column,
}: {
  readonly column: Column<SubscriptionRow>;
}): React.ReactElement | null {
  if (!column.getCanFilter()) return null;

  if (column.id === 'name') {
    const value = column.getFilterValue();
    return (
      <TextFilter
        label="Name"
        placeholder="netflix"
        value={typeof value === 'string' ? value : ''}
        onChange={(next) => {
          column.setFilterValue(next === '' ? undefined : next);
        }}
      />
    );
  }

  const options = OPTION_SETS[column.id];
  if (options === undefined) return null;

  return (
    <OptionFilter
      label={FILTER_LABELS[column.id] ?? column.id}
      options={options}
      selected={toStringArray(column.getFilterValue())}
      onChange={(next) => {
        column.setFilterValue(next.length === 0 ? undefined : [...next]);
      }}
    />
  );
}

// ── cells ────────────────────────────────────────────────────────────────────────────────

/**
 * A group row spans the whole grid rather than filling cells, because the thing it has to say —
 * "Streaming video, 6 subscriptions, £47.94" — is a sentence, not a row of columns.
 */
function GroupHeaderRow({
  row,
  locale,
}: {
  readonly row: Row<SubscriptionRow>;
  readonly locale: string;
}): React.ReactElement {
  const leaves = row.getLeafRows().filter((leaf) => !leaf.getIsGrouped());
  // Only totalled when every row in the group shares a currency — there is no rate table, and a
  // mixed-currency sum is a wrong number wearing a right number's clothes.
  const total = sumIfSingleCurrency(
    leaves.map((leaf) => ({ amountMinor: leaf.original.amountMinor, currency: leaf.original.currency })),
  );
  const raw = row.groupingValue;
  const label = groupLabel(row.groupingColumnId ?? '', typeof raw === 'string' ? raw : '');
  const Chevron = row.getIsExpanded() ? ChevronDown : ChevronRight;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Chevron className="size-3.5 shrink-0 text-text-3" aria-hidden />
      <span className="eyebrow truncate">{label}</span>
      <span className="font-mono text-xs text-text-3">{leaves.length}</span>
      {total === null ? null : (
        <Money
          amountMinor={total.amountMinor}
          currency={total.currency}
          tone="outflow"
          size="sm"
          locale={locale}
          className="ml-auto"
        />
      )}
    </div>
  );
}

function groupLabel(columnId: string, value: string): string {
  if (value === '') return 'Ungrouped';
  if (columnId === 'category') return CATEGORY_LABELS[value as Category];
  if (columnId === 'channel') return BILLING_CHANNEL_LABELS[value as BillingChannel];
  return value;
}

function NameCell({ row }: { readonly row: SubscriptionRow }): React.ReactElement {
  const ui = useRowUi();
  const editing = ui.editing?.rowId === row.id && ui.editing.column === 'name';

  if (editing) {
    return (
      <InlineInput
        initial={row.displayName}
        label="Name"
        onCommit={(value) => {
          ui.commitName(row, value);
        }}
        onCancel={ui.cancelEdit}
      />
    );
  }

  return (
    <button
      type="button"
      tabIndex={ui.focusedRowId === row.id ? 0 : -1}
      aria-label={`${row.displayName}. Edit name`}
      onDoubleClick={() => {
        ui.startEdit(row.id, 'name');
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          ui.startEdit(row.id, 'name');
        }
      }}
      className={cn('flex min-w-0 items-center gap-2 rounded-sm text-left', focusRing)}
    >
      <MerchantMark name={row.merchantName ?? row.displayName} logoUrl={row.merchantLogo} />
      <span className="min-w-0">
        <span className="block truncate text-text">{row.displayName}</span>
        {row.merchantName !== null && row.merchantName !== row.displayName ? (
          <span className="block truncate text-[0.6875rem] leading-tight text-text-3">{row.merchantName}</span>
        ) : null}
      </span>
    </button>
  );
}

function AmountCell({ row }: { readonly row: SubscriptionRow }): React.ReactElement {
  const ui = useRowUi();
  const editing = ui.editing?.rowId === row.id && ui.editing.column === 'amount';

  if (editing) {
    return (
      <InlineInput
        // Seeded with the exact decimal string — built by integer division and string assembly
        // in core, never by dividing the minor units by 100 in a float.
        initial={editableAmount(row.amountMinor, row.currency)}
        label="Amount"
        mono
        alignEnd
        onCommit={(value) => {
          ui.commitAmount(row, value);
        }}
        onCancel={ui.cancelEdit}
      />
    );
  }

  return (
    <button
      type="button"
      tabIndex={ui.focusedRowId === row.id ? 0 : -1}
      aria-label={`Edit amount for ${row.displayName}`}
      onDoubleClick={() => {
        ui.startEdit(row.id, 'amount');
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          ui.startEdit(row.id, 'amount');
        }
      }}
      className={cn('flex items-center justify-end gap-1 rounded-sm', focusRing)}
    >
      {row.variableAmount ? (
        <span className="text-[0.6875rem] text-text-3" title="Variable — this is the median charge">
          ~
        </span>
      ) : null}
      <Money amountMinor={row.amountMinor} currency={row.currency} tone="outflow" locale={ui.locale} />
    </button>
  );
}

function editableAmount(amountMinor: number, currencyCode: string): string {
  try {
    return toDecimalString(money(amountMinor, currencyCode));
  } catch {
    return '';
  }
}

interface InlineInputProps {
  readonly initial: string;
  readonly label: string;
  readonly mono?: boolean;
  readonly alignEnd?: boolean;
  readonly onCommit: (value: string) => void;
  readonly onCancel: () => void;
}

/**
 * The editing state of a cell.
 *
 * Commits on blur as well as on Enter: a user who types a new price and clicks the next row
 * means to keep the price. Escape is the only way to discard, and it is the only key that does.
 */
function InlineInput({
  initial,
  label,
  mono = false,
  alignEnd = false,
  onCommit,
  onCancel,
}: InlineInputProps): React.ReactElement {
  const [value, setValue] = React.useState(initial);
  const cancelled = React.useRef(false);

  return (
    <input
      autoFocus
      aria-label={label}
      value={value}
      onFocus={(event) => {
        event.target.select();
      }}
      onChange={(event) => {
        setValue(event.target.value);
      }}
      onKeyDown={(event) => {
        // Stopped here so Space and the arrow keys type instead of moving the row focus.
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          onCommit(value);
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelled.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!cancelled.current) onCommit(value);
      }}
      className={cn(
        'h-7 w-full min-w-0 rounded-sm border border-control bg-ink-900 px-1.5 text-[0.8125rem] text-text outline-none',
        mono && 'font-mono tabular-nums',
        alignEnd && 'text-right',
      )}
    />
  );
}

function NextChargeCell({ row }: { readonly row: SubscriptionRow }): React.ReactElement {
  const ui = useRowUi();
  if (row.nextRenewalAt === null) return <span className="text-text-3">—</span>;

  const date = fromInstant(row.nextRenewalAt, ui.timezone);
  const days = daysUntil(date, ui.today);

  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      {/* Amber inside a week: this is money about to leave, the same colour as the amount. */}
      <span className={cn('shrink-0', days <= 7 ? 'text-outflow' : 'text-text-2')}>
        {formatRelativeDay(date, ui.today, ui.locale)}
      </span>
      <time dateTime={formatPlainDate(date)} className="truncate font-mono text-[0.6875rem] text-text-3">
        {formatDay(date, ui.locale)}
      </time>
    </span>
  );
}

/**
 * `problem` is set from a fact, never from the status: a trial about to convert and a cancel-by
 * date that has passed are problems. An active subscription charging what it said it would is
 * not, and painting it red is how an alert colour stops meaning anything.
 */
function StatusCell({ row }: { readonly row: SubscriptionRow }): React.ReactElement {
  const ui = useRowUi();

  const trialClosing =
    row.status === 'trialing' &&
    row.trialEndsAt !== null &&
    daysUntil(fromInstant(row.trialEndsAt, ui.timezone), ui.today) <= 3;

  const cancelByMissed =
    row.cancelByAt !== null && daysUntil(fromInstant(row.cancelByAt, ui.timezone), ui.today) < 0;

  return <StatusPill status={row.status} problem={trialClosing || cancelByMissed} />;
}

/**
 * The merchant logo, or the initial — including when there is a logo that fails to load, which
 * for a remote logo host is a question of when rather than whether.
 */
function MerchantMark({
  name,
  logoUrl,
}: {
  readonly name: string;
  readonly logoUrl: string | null;
}): React.ReactElement {
  const [failed, setFailed] = React.useState(false);
  const initial = name.trim().charAt(0).toUpperCase();

  if (logoUrl === null || failed) {
    return (
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center rounded-sm border border-line bg-ink-700 text-[0.6875rem] font-medium text-text-2"
      >
        {initial === '' ? '?' : initial}
      </span>
    );
  }

  return (
    <img
      src={logoUrl}
      alt=""
      width={20}
      height={20}
      loading="lazy"
      onError={() => {
        setFailed(true);
      }}
      className="size-5 shrink-0 rounded-sm border border-line bg-ink-700 object-contain"
    />
  );
}
