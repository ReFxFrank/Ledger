'use client';

/**
 * The bar above the table: search, grouping, archived, saved views, and the two ways to get a
 * subscription into the product.
 *
 * Per-column filters are not here — they live in the column headers, next to the data they act
 * on, so a filtered column is visibly filtered rather than filtered by something two feet away.
 * What is here is everything that acts on the table as a whole.
 */

import * as React from 'react';
import Link from 'next/link';
import { Bookmark, Check, FileUp, Layers, Plus, Search, Trash2, X } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Switch,
  cn,
  focusRing,
} from '@ledger/ui';
import {
  type SavedView,
  type ViewSnapshot,
  useSubscriptionViews,
  useViewsHydrated,
} from '~/lib/stores/subscription-views';
import { GROUPABLE_COLUMNS } from './types';

export interface SubscriptionsToolbarProps {
  readonly searchRef: React.RefObject<HTMLInputElement | null>;
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly grouping: readonly string[];
  readonly onGroupingChange: (value: readonly string[]) => void;
  readonly includeArchived: boolean;
  readonly onIncludeArchivedChange: (value: boolean) => void;
  readonly activeFilterCount: number;
  readonly onClearFilters: () => void;
  readonly snapshot: ViewSnapshot;
  readonly onApplyView: (view: SavedView) => void;
  readonly onAddSubscription: () => void;
  readonly shownCount: number;
  readonly totalCount: number;
}

export function SubscriptionsToolbar({
  searchRef,
  search,
  onSearchChange,
  grouping,
  onGroupingChange,
  includeArchived,
  onIncludeArchivedChange,
  activeFilterCount,
  onClearFilters,
  snapshot,
  onApplyView,
  onAddSubscription,
  shownCount,
  totalCount,
}: SubscriptionsToolbarProps): React.ReactElement {
  const views = useSubscriptionViews((state) => state.views);
  const activeViewId = useSubscriptionViews((state) => state.activeViewId);
  const saveView = useSubscriptionViews((state) => state.saveView);
  const replaceView = useSubscriptionViews((state) => state.replaceView);
  const removeView = useSubscriptionViews((state) => state.removeView);
  const hydrated = useViewsHydrated();

  const [savingOpen, setSavingOpen] = React.useState(false);
  const [draftName, setDraftName] = React.useState('');

  const activeView = views.find((view) => view.id === activeViewId) ?? null;
  const groupedBy = grouping[0] ?? null;

  function commitSave(): void {
    const name = draftName.trim();
    if (name === '') return;
    saveView(name, snapshot);
    setDraftName('');
    setSavingOpen(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-[var(--gap-tight)]">
      {/* Search. The `/` hint is not decoration — it is the only advertisement the shortcut gets. */}
      <div className="relative min-w-0 grow basis-56">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-3"
          aria-hidden
        />
        <Input
          ref={searchRef}
          type="search"
          value={search}
          onChange={(event) => {
            onSearchChange(event.target.value);
          }}
          placeholder="Search subscriptions"
          aria-label="Search subscriptions"
          className="pl-8 pr-10"
        />
        <kbd
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-sm border border-line px-1 py-0.5 text-[0.6875rem] leading-none text-text-3"
        >
          /
        </kbd>
      </div>

      {/* Group by */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant={groupedBy === null ? 'ghost' : 'secondary'}>
            <Layers className="size-3.5" aria-hidden />
            {groupedBy === null
              ? 'Group'
              : `Grouped by ${(GROUPABLE_COLUMNS.find((column) => column.id === groupedBy)?.label ?? groupedBy).toLowerCase()}`}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Group rows by</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => {
              onGroupingChange([]);
            }}
          >
            <Check className={cn('size-3.5', groupedBy !== null && 'invisible')} aria-hidden />
            No grouping
          </DropdownMenuItem>
          {GROUPABLE_COLUMNS.map((column) => (
            <DropdownMenuItem
              key={column.id}
              onSelect={() => {
                onGroupingChange([column.id]);
              }}
            >
              <Check className={cn('size-3.5', groupedBy !== column.id && 'invisible')} aria-hidden />
              {column.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Saved views */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant={activeView === null ? 'ghost' : 'secondary'}>
            <Bookmark className="size-3.5" aria-hidden />
            {activeView === null ? 'Views' : activeView.name}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuLabel>Saved views</DropdownMenuLabel>
          {!hydrated || views.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-text-2">
              Save the filters, sort and grouping you use most, and come back to them in one click.
            </p>
          ) : (
            views.map((view) => (
              <div key={view.id} className="flex items-center gap-1">
                <DropdownMenuItem
                  className="grow"
                  onSelect={() => {
                    onApplyView(view);
                  }}
                >
                  <Check className={cn('size-3.5', activeViewId !== view.id && 'invisible')} aria-hidden />
                  <span className="truncate">{view.name}</span>
                </DropdownMenuItem>
                <button
                  type="button"
                  aria-label={`Delete view ${view.name}`}
                  onClick={() => {
                    removeView(view.id);
                  }}
                  className={cn(
                    'mr-1 grid size-6 shrink-0 place-items-center rounded-sm text-text-3',
                    'transition-colors duration-[var(--duration-fast)] ease-standard hover:bg-alert-dim hover:text-alert',
                    focusRing,
                  )}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </div>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setSavingOpen(true);
            }}
          >
            <Plus className="size-3.5" aria-hidden />
            Save this view
          </DropdownMenuItem>
          {activeView === null ? null : (
            <DropdownMenuItem
              onSelect={() => {
                replaceView(activeView.id, snapshot);
              }}
            >
              <Bookmark className="size-3.5" aria-hidden />
              Update &ldquo;{activeView.name}&rdquo;
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {activeFilterCount > 0 ? (
        <Button size="sm" variant="ghost" onClick={onClearFilters}>
          <X className="size-3.5" aria-hidden />
          Clear {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'}
        </Button>
      ) : null}

      <div className="ml-auto flex flex-wrap items-center gap-[var(--gap-tight)]">
        <span className="font-mono text-xs text-text-3" aria-live="polite">
          {shownCount === totalCount
            ? `${String(totalCount)} tracked`
            : `${String(shownCount)} of ${String(totalCount)}`}
        </span>

        <div className="flex items-center gap-1.5">
          <Switch
            id="include-archived"
            checked={includeArchived}
            onCheckedChange={onIncludeArchivedChange}
          />
          <Label htmlFor="include-archived">Archived</Label>
        </div>

        <Button size="sm" variant="ghost" asChild>
          <Link href="/subscriptions/import">
            <FileUp className="size-3.5" aria-hidden />
            Import CSV
          </Link>
        </Button>

        <Button size="sm" variant="primary" onClick={onAddSubscription}>
          <Plus className="size-3.5" aria-hidden />
          Add subscription
        </Button>
      </div>

      <Dialog open={savingOpen} onOpenChange={setSavingOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save this view</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <Label htmlFor="view-name" required>
              Name
            </Label>
            <Input
              id="view-name"
              value={draftName}
              autoFocus
              placeholder="Everything on Apple"
              className="mt-1.5"
              onChange={(event) => {
                setDraftName(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitSave();
                }
              }}
            />
            <p className="mt-2 text-xs text-text-2">
              Saves the search, filters, sort and grouping to this browser.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSavingOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={commitSave} disabled={draftName.trim() === ''}>
              Save view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
