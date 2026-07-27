'use client';

/**
 * The bar that appears when rows are selected.
 *
 * It docks to the bottom of the table rather than floating over the page, so it never covers the
 * rows the user is deciding about. Every action here is a bulk mutation, so every one of them
 * ends in a count the user can check against what they thought they had selected.
 */

import * as React from 'react';
import { Archive, FolderTree, Tag, Tags, X, Pencil } from 'lucide-react';
import { CATEGORIES, CATEGORY_LABELS, type Category } from '@ledger/core';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
} from '@ledger/ui';
import { api } from '~/lib/trpc';

export interface BulkActionBarProps {
  readonly ids: readonly string[];
  readonly onClearSelection: () => void;
  /**
   * Opens the full editor for a single subscription. Offered only when exactly one row is
   * selected — a user with one row picked and a wrong cadence in front of them asked how to fix
   * it, and the honest answer was a detour through the detail page. Editing is not a bulk
   * operation, so the button disappears the moment a second row joins the selection.
   */
  readonly onEditSingle?: (id: string) => void;
}

export function BulkActionBar({
  ids,
  onClearSelection,
  onEditSingle,
}: BulkActionBarProps): React.ReactElement {
  const utils = api.useUtils();
  const [tagDraft, setTagDraft] = React.useState('');
  const [tagMode, setTagMode] = React.useState<'add' | 'remove'>('add');
  const [tagOpen, setTagOpen] = React.useState(false);

  // Bulk writes touch up to 200 rows, so there is no honest optimistic patch to apply — the
  // server decides which of them it could actually update. Refetch and show the count instead.
  async function refresh(): Promise<void> {
    await utils.subscriptions.list.invalidate();
    await utils.dashboard.totals.invalidate();
  }

  const bulkUpdate = api.subscriptions.bulkUpdate.useMutation({
    onSuccess: async (result) => {
      await refresh();
      toast.success(`${String(result.count)} updated.`);
      onClearSelection();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const archive = api.subscriptions.archive.useMutation({
    onSuccess: async (result) => {
      await refresh();
      toast.success(`${String(result.count)} archived.`, {
        description: 'Archived subscriptions keep their history. Turn on Archived to bring them back.',
      });
      onClearSelection();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const busy = bulkUpdate.isPending || archive.isPending;
  const mutableIds = [...ids];

  function commitTag(): void {
    const tag = tagDraft.trim();
    if (tag === '') return;
    bulkUpdate.mutate(
      tagMode === 'add' ? { ids: mutableIds, addTags: [tag] } : { ids: mutableIds, removeTags: [tag] },
    );
    setTagDraft('');
    setTagOpen(false);
  }

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="flex flex-wrap items-center gap-[var(--gap-tight)] border-t border-line-hot bg-ink-700 px-[var(--pad-card)] py-2"
    >
      <span className="font-mono text-xs text-text">
        {ids.length} selected
      </span>

      {ids.length === 1 && ids[0] !== undefined && onEditSingle !== undefined ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            const only = ids[0];
            if (only !== undefined) onEditSingle(only);
          }}
        >
          <Pencil className="size-3.5" aria-hidden />
          Edit
        </Button>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="secondary" disabled={busy}>
            <FolderTree className="size-3.5" aria-hidden />
            Categorize
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          <DropdownMenuLabel>Move to category</DropdownMenuLabel>
          {CATEGORIES.map((category: Category) => (
            <DropdownMenuItem
              key={category}
              onSelect={() => {
                bulkUpdate.mutate({ ids: mutableIds, category });
              }}
            >
              {CATEGORY_LABELS[category]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Popover open={tagOpen} onOpenChange={setTagOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="secondary" disabled={busy}>
            <Tag className="size-3.5" aria-hidden />
            Tags
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64">
          <div className="flex flex-col gap-[var(--gap-tight)]">
            <p className="eyebrow">Tag {ids.length} subscriptions</p>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={tagMode === 'add' ? 'primary' : 'ghost'}
                onClick={() => {
                  setTagMode('add');
                }}
              >
                Add
              </Button>
              <Button
                size="sm"
                variant={tagMode === 'remove' ? 'primary' : 'ghost'}
                onClick={() => {
                  setTagMode('remove');
                }}
              >
                Remove
              </Button>
            </div>
            <Input
              value={tagDraft}
              placeholder="work"
              aria-label={tagMode === 'add' ? 'Tag to add' : 'Tag to remove'}
              onChange={(event) => {
                setTagDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitTag();
                }
              }}
            />
            <Button size="sm" variant="secondary" onClick={commitTag} disabled={tagDraft.trim() === ''}>
              <Tags className="size-3.5" aria-hidden />
              {tagMode === 'add' ? 'Add tag' : 'Remove tag'}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() => {
          archive.mutate({ ids: mutableIds, archived: true });
        }}
      >
        <Archive className="size-3.5" aria-hidden />
        Archive
      </Button>

      <Button size="sm" variant="ghost" className="ml-auto" onClick={onClearSelection}>
        <X className="size-3.5" aria-hidden />
        Clear
      </Button>
    </div>
  );
}
