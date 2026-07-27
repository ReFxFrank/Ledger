'use client';

import * as React from 'react';
import Link from 'next/link';
import { CheckCheck, Inbox } from 'lucide-react';
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DescriptorLegend,
  EmptyState,
  Money,
  Panel,
  PanelBody,
  PanelHeader,
  toast,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import type { ReviewItem } from '~/lib/api-types';
import { LoadError } from '../dashboard/states';
import { CandidateCard } from './candidate';
import { EditConfirmDialog, MergeDialog, type EditOverrides } from './dialogs';
import { ReviewSkeleton } from './skeleton';

/**
 * The detection review queue.
 *
 * Three things this screen is built around:
 *
 *  1. **Nothing is confirmed without its evidence on screen.** Every card carries the decoded
 *     descriptor; the charges are one key away. A queue that hides its reasoning is a list of
 *     guesses, and a user who confirms guesses ends up with a subscription list they distrust.
 *  2. **Bulk confirm states its scope before the click.** The button carries the count, and the
 *     dialog names every subscription that is about to exist. The server refuses anything below
 *     the auto-confirm bar; this screen never offers those in the batch in the first place.
 *  3. **The keyboard is the fast path.** J/K or the arrows move, Y confirms, N dismisses, E
 *     edits, M merges. Someone clearing thirty suggestions should never have to reach for a
 *     pointer, and the shortcuts are advertised on the screen rather than hidden in a help page.
 */

/** How many suggestions to pull at once. The server caps at 200; this is a screenful and then some. */
const PAGE_LIMIT = 50;

const LIST_INPUT = { status: 'pending', limit: PAGE_LIMIT, cursor: 0 } as const;

type DialogState =
  | { readonly kind: 'none' }
  | { readonly kind: 'edit'; readonly item: ReviewItem }
  | { readonly kind: 'merge'; readonly item: ReviewItem }
  | { readonly kind: 'bulk' };

export function ReviewQueue(): React.ReactNode {
  const utils = api.useUtils();

  const me = api.me.current.useQuery();
  const queue = api.review.list.useQuery(LIST_INPUT);

  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = React.useState<DialogState>({ kind: 'none' });
  /** Rows with a mutation in flight, so a double press cannot fire the same action twice. */
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());

  const listRef = React.useRef<HTMLUListElement>(null);
  const wantsFocus = React.useRef(false);

  const items = React.useMemo(() => queue.data?.items ?? [], [queue.data]);
  const locale = me.data?.locale ?? 'en-GB';
  const timezone = me.data?.timezone ?? 'UTC';

  const eligible = React.useMemo(() => items.filter((item) => item.canBulkConfirm), [items]);
  const selectedItems = React.useMemo(
    () => eligible.filter((item) => selected.has(item.detection.id)),
    [eligible, selected],
  );

  // ── mutations ────────────────────────────────────────────────────────────────────────

  const markBusy = React.useCallback((id: string, on: boolean) => {
    setBusy((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /**
   * Every review action changes three things: the queue, the sidebar badge, and — for anything
   * that promotes a detection — the subscription list and the dashboard totals. They are
   * invalidated together so the app cannot show a confirmed subscription that is still sitting in
   * the queue behind it.
   */
  const refreshAll = React.useCallback(async (): Promise<void> => {
    await Promise.all([
      utils.review.list.invalidate(),
      utils.dashboard.attention.invalidate(),
      utils.dashboard.totals.invalidate(),
      utils.subscriptions.list.invalidate(),
    ]);
  }, [utils]);

  const confirm = api.review.confirm.useMutation({
    onSuccess: (created) => {
      toast.success(`${created.displayName} is now tracked.`);
    },
    onError: (error) => {
      toast.error('Could not confirm that.', { description: error.message });
    },
    onSettled: async (_data, _error, variables) => {
      markBusy(variables.detectionId, false);
      await refreshAll();
    },
  });

  const dismiss = api.review.dismiss.useMutation({
    onSuccess: () => {
      toast.success('Dismissed. We will not suggest it again.');
    },
    onError: (error) => {
      toast.error('Could not dismiss that.', { description: error.message });
    },
    onSettled: async (_data, _error, variables) => {
      markBusy(variables.detectionId, false);
      await Promise.all([utils.review.list.invalidate(), utils.dashboard.attention.invalidate()]);
    },
  });

  const merge = api.review.merge.useMutation({
    onSuccess: () => {
      toast.success('Merged into the existing subscription.');
      setDialog({ kind: 'none' });
    },
    onError: (error) => {
      toast.error('Could not merge that.', { description: error.message });
    },
    onSettled: async (_data, _error, variables) => {
      markBusy(variables.detectionId, false);
      await refreshAll();
    },
  });

  const bulkConfirm = api.review.bulkConfirm.useMutation({
    onSuccess: (result) => {
      // The server's own message names how many were skipped and why. Restating it here in
      // friendlier words would be the fastest way for the two to disagree.
      toast.success(result.message);
      setSelected(new Set());
      setDialog({ kind: 'none' });
    },
    onError: (error) => {
      toast.error('Nothing was confirmed.', { description: error.message });
    },
    onSettled: async () => {
      await refreshAll();
    },
  });

  // ── row actions ──────────────────────────────────────────────────────────────────────

  const runConfirm = React.useCallback(
    (item: ReviewItem, overrides: EditOverrides = {}) => {
      markBusy(item.detection.id, true);
      confirm.mutate({ detectionId: item.detection.id, overrides });
      setDialog({ kind: 'none' });
    },
    [confirm, markBusy],
  );

  const runDismiss = React.useCallback(
    (item: ReviewItem, reason?: string) => {
      markBusy(item.detection.id, true);
      dismiss.mutate({
        detectionId: item.detection.id,
        // `exactOptionalPropertyTypes`: an explicit `undefined` is a different thing from an
        // absent key, and the router treats an absent reason as "no reason given".
        ...(reason === undefined ? {} : { reason }),
      });
    },
    [dismiss, markBusy],
  );

  const runMerge = React.useCallback(
    (item: ReviewItem, subscriptionId: string) => {
      markBusy(item.detection.id, true);
      merge.mutate({ detectionId: item.detection.id, subscriptionId });
    },
    [markBusy, merge],
  );

  // ── keyboard ─────────────────────────────────────────────────────────────────────────

  const moveFocus = React.useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(next, items.length - 1));
      wantsFocus.current = true;
      setFocusedIndex(clamped);
    },
    [items.length],
  );

  React.useEffect(() => {
    if (!wantsFocus.current) return;
    wantsFocus.current = false;
    const target = listRef.current?.querySelector<HTMLElement>(
      `[data-row-index="${String(focusedIndex)}"]`,
    );
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  // A shrinking queue must not leave the caret pointing past the end — the next Y would then do
  // nothing, and the user would press it again harder.
  React.useEffect(() => {
    setFocusedIndex((current) => Math.max(0, Math.min(current, items.length - 1)));
  }, [items.length]);

  function onListKeyDown(event: React.KeyboardEvent<HTMLUListElement>): void {
    const target = event.target;
    const inField =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (inField || event.metaKey || event.ctrlKey || event.altKey) return;

    const item = items[focusedIndex];

    switch (event.key) {
      case 'ArrowDown':
      case 'j':
      case 'J':
        event.preventDefault();
        moveFocus(focusedIndex + 1);
        return;
      case 'ArrowUp':
      case 'k':
      case 'K':
        event.preventDefault();
        moveFocus(focusedIndex - 1);
        return;
      case 'Home':
        event.preventDefault();
        moveFocus(0);
        return;
      case 'End':
        event.preventDefault();
        moveFocus(items.length - 1);
        return;
      default:
        break;
    }

    if (item === undefined || busy.has(item.detection.id)) return;

    switch (event.key) {
      case 'y':
      case 'Y':
        event.preventDefault();
        runConfirm(item);
        return;
      case 'n':
      case 'N':
        event.preventDefault();
        // No reason, deliberately: the keyboard path is for clearing a queue quickly, and
        // stopping to categorise every dismissal is the thing that makes people stop clearing it.
        runDismiss(item);
        return;
      case 'e':
      case 'E':
        event.preventDefault();
        setDialog({ kind: 'edit', item });
        return;
      case 'm':
      case 'M':
        event.preventDefault();
        setDialog({ kind: 'merge', item });
        return;
      case 'Enter':
        event.preventDefault();
        setExpandedId((current) => (current === item.detection.id ? null : item.detection.id));
        return;
      case ' ':
        if (!item.canBulkConfirm) return;
        event.preventDefault();
        toggleSelected(item.detection.id, !selected.has(item.detection.id));
        return;
      default:
        break;
    }
  }

  function toggleSelected(id: string, next: boolean): void {
    setSelected((previous) => {
      const updated = new Set(previous);
      if (next) updated.add(id);
      else updated.delete(id);
      return updated;
    });
  }

  // ── render ───────────────────────────────────────────────────────────────────────────

  if (queue.error !== null) {
    return (
      <Panel>
        <PanelHeader eyebrow="Review" />
        <PanelBody>
          <LoadError
            what="the review queue"
            error={queue.error}
            retrying={queue.isFetching}
            onRetry={() => {
              void queue.refetch();
            }}
          />
        </PanelBody>
      </Panel>
    );
  }

  if (queue.isPending) return <ReviewSkeleton />;

  if (items.length === 0) {
    return (
      <Panel>
        <PanelHeader eyebrow="Review">Nothing to review.</PanelHeader>
        <EmptyState
          icon={<Inbox />}
          actions={
            <Button size="sm" variant="secondary" asChild>
              <Link href="/subscriptions">Open your subscriptions</Link>
            </Button>
          }
        >
          This is the good state. Every charge the engine recognised has already been dealt with,
          and new suggestions will land here on their own after the next sync.
        </EmptyState>
      </Panel>
    );
  }

  const bulkCount = selectedItems.length;

  return (
    <>
      <Panel>
        <PanelHeader
          eyebrow="Detected subscriptions"
          actions={
            <div className="flex flex-wrap items-center gap-[var(--gap-tight)]">
              {eligible.length > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSelected(
                      bulkCount === eligible.length
                        ? new Set()
                        : new Set(eligible.map((item) => item.detection.id)),
                    );
                  }}
                >
                  {bulkCount === eligible.length ? 'Clear selection' : `Select all ${eligible.length}`}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="primary"
                disabled={bulkCount === 0}
                onClick={() => {
                  setDialog({ kind: 'bulk' });
                }}
              >
                <CheckCheck className="size-3.5" aria-hidden />
                {bulkCount === 0
                  ? 'Confirm selected'
                  : `Confirm ${bulkCount} ${bulkCount === 1 ? 'suggestion' : 'suggestions'}`}
              </Button>
            </div>
          }
        >
          {items.length} {items.length === 1 ? 'suggestion is' : 'suggestions are'} waiting on you.{' '}
          {eligible.length === 0
            ? 'None of them clears the bar for confirming in bulk — check each one.'
            : `${eligible.length} of them the engine is confident enough about to confirm in a batch.`}
        </PanelHeader>

        <div className="flex flex-wrap items-center justify-between gap-[var(--gap)] border-b border-line px-[var(--pad-panel)] py-[var(--gap-tight)]">
          <DescriptorLegend />
          <p className="text-[0.6875rem] text-text-3">
            <Key>J</Key>/<Key>K</Key> move · <Key>Y</Key> confirm · <Key>N</Key> dismiss ·{' '}
            <Key>E</Key> edit · <Key>M</Key> merge · <Key>Enter</Key> charges
          </p>
        </div>

        <ul
          ref={listRef}
          onKeyDown={onListKeyDown}
          aria-label="Detection suggestions"
          className="flex flex-col gap-[var(--gap)] p-[var(--pad-panel)]"
        >
          {items.map((item, index) => (
            <CandidateCard
              key={item.detection.id}
              item={item}
              index={index}
              focused={index === focusedIndex}
              expanded={expandedId === item.detection.id}
              selected={selected.has(item.detection.id)}
              busy={busy.has(item.detection.id)}
              locale={locale}
              timezone={timezone}
              showLegend={false}
              onFocus={() => {
                setFocusedIndex(index);
              }}
              onToggleExpanded={() => {
                setExpandedId((current) => (current === item.detection.id ? null : item.detection.id));
              }}
              onToggleSelected={(next) => {
                toggleSelected(item.detection.id, next);
              }}
              onConfirm={() => {
                runConfirm(item);
              }}
              onDismiss={(reason) => {
                runDismiss(item, reason);
              }}
              onEdit={() => {
                setDialog({ kind: 'edit', item });
              }}
              onMerge={() => {
                setDialog({ kind: 'merge', item });
              }}
            />
          ))}
        </ul>

        {queue.data.nextCursor === null ? null : (
          <div className="border-t border-line px-[var(--pad-panel)] py-[var(--gap-loose)] text-xs text-text-2">
            Showing the first {PAGE_LIMIT}. Clear some and the rest will appear.
          </div>
        )}
      </Panel>

      {dialog.kind === 'edit' ? (
        <EditConfirmDialog
          key={dialog.item.detection.id}
          item={dialog.item}
          open
          pending={confirm.isPending}
          onOpenChange={(next) => {
            if (!next) setDialog({ kind: 'none' });
          }}
          onSubmit={(overrides) => {
            runConfirm(dialog.item, overrides);
          }}
        />
      ) : null}

      {dialog.kind === 'merge' ? (
        <MergeDialog
          key={dialog.item.detection.id}
          item={dialog.item}
          open
          pending={merge.isPending}
          onOpenChange={(next) => {
            if (!next) setDialog({ kind: 'none' });
          }}
          onSubmit={(subscriptionId) => {
            runMerge(dialog.item, subscriptionId);
          }}
        />
      ) : null}

      <BulkConfirmDialog
        open={dialog.kind === 'bulk'}
        items={selectedItems}
        locale={locale}
        pending={bulkConfirm.isPending}
        onOpenChange={(next) => {
          if (!next) setDialog({ kind: 'none' });
        }}
        onConfirm={() => {
          bulkConfirm.mutate({ detectionIds: selectedItems.map((item) => item.detection.id) });
        }}
      />
    </>
  );
}

function Key({ children }: { readonly children: string }): React.ReactNode {
  return (
    <kbd className="rounded-sm border border-line px-1 font-mono text-[0.625rem] leading-4 text-text-2">
      {children}
    </kbd>
  );
}

/**
 * The batch, named before it happens.
 *
 * "Confirm all" that turns out to have confirmed six of eleven is how someone stops believing
 * their own subscription list, so this lists every row that is about to become a subscription and
 * the exact count, and the button repeats the number.
 */
function BulkConfirmDialog({
  open,
  items,
  locale,
  pending,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean;
  readonly items: readonly ReviewItem[];
  readonly locale: string;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}): React.ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Confirm {items.length} {items.length === 1 ? 'suggestion' : 'suggestions'}
          </DialogTitle>
          <DialogDescription>
            Each one becomes a tracked subscription with the amount and cadence shown. You can edit
            any of them afterwards.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <ul className="max-h-72 overflow-y-auto rounded-md border border-line">
            {items.map((item) => (
              <li
                key={item.detection.id}
                className="flex items-center justify-between gap-[var(--gap)] border-b border-line px-[var(--pad-card)] py-2 last:border-b-0"
              >
                <span className="min-w-0 truncate text-[0.8125rem] text-text">
                  {item.merchantName ?? item.detection.normalizedKey}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone="control" mono>
                    {Math.round(Number(item.detection.confidence) * 100)}%
                  </Badge>
                  <Money
                    amountMinor={item.detection.medianAmountMinor}
                    currency={item.detection.currency}
                    tone="outflow"
                    size="sm"
                    locale={locale}
                  />
                </span>
              </li>
            ))}
          </ul>
        </DialogBody>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={onConfirm}>
            Confirm {items.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
