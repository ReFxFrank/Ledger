'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData } from '@tanstack/react-query';
import {
  Download,
  FileUp,
  Inbox,
  Keyboard,
  Link2,
  Plus,
  Slash,
  type LucideIcon,
} from 'lucide-react';
import { interval, intervalLabel } from '@ledger/core';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandMeta,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Money,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import {
  COMMAND_MENU_EVENT,
  SHORTCUTS_EVENT,
  isTypingTarget,
  useModifierLabel,
} from '~/lib/keyboard';
import { usePendingIntent } from '~/lib/stores/pending-intent';
import { NAV_ROUTES } from './nav/routes';
import { ShortcutsDialog } from './nav/shortcuts-dialog';

/**
 * The command palette, and the app's global keyboard bindings.
 *
 * Mounted once, in the authenticated shell. Both halves live here on purpose: the ⌘K binding and
 * the thing ⌘K opens are one feature, and when they were in two files the button owned the
 * keystroke while nothing owned the dialog.
 *
 * ## What it will not do
 *
 * No bare key is bound while text has focus — see `isTypingTarget`. This is the rule that makes
 * the rest of the bindings affordable: `g` can mean "go" precisely because it cannot mean "go"
 * while someone is typing "gym membership" into the search box above it. ⌘K is exempt because a
 * modifier chord is not a keystroke anyone is trying to type.
 *
 * `/` is **not** bound here, and that is deliberate rather than unfinished. The subscriptions
 * table already claims it (`components/subscriptions/table.tsx`) and focuses its own search;
 * binding it a second time at the window level would give one keypress two handlers, and the
 * order they run in is an accident of mount order. The review queue has no search field to
 * focus, so there is nothing there for `/` to do — it is left unbound rather than bound to
 * something invented for the sake of symmetry.
 *
 * ## Filtering
 *
 * `shouldFilter={false}`: the subscription rows arrive already filtered by Postgres, on a query
 * that also matches notes, and letting cmdk's fuzzy scorer re-filter them would hide server
 * matches whose reason for matching is not in the visible label. Navigation and actions are
 * matched here instead, with a plain substring test — predictable beats clever in a list a
 * person is reading while they type.
 */

/** Long enough that a fast typist sends one query, short enough to feel like it kept up. */
const SEARCH_DEBOUNCE_MS = 150;

/** A screenful of results; the palette is a shortcut, not a second subscriptions table. */
const RESULT_LIMIT = 6;

/** How long `g` stays armed waiting for its second key. Roughly one deliberate keypress. */
const CHORD_WINDOW_MS = 1200;

interface CommandRow {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Extra words the row should match on. Lowercase — the matcher does not case-fold these. */
  readonly keywords: readonly string[];
  readonly perform: () => void;
  /** Trailing hint: a count, a shortcut. */
  readonly meta?: React.ReactNode;
}

function matches(query: string, label: string, keywords: readonly string[]): boolean {
  if (query === '') return true;
  if (label.toLowerCase().includes(query)) return true;
  return keywords.some((word) => word.includes(query));
}

function useDebounced(value: string, delayMs: number): string {
  const [settled, setSettled] = React.useState(value);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return settled;
}

export function CommandPalette(): React.ReactNode {
  const router = useRouter();
  const modifier = useModifierLabel();
  const requestNewSubscription = usePendingIntent((state) => state.requestNewSubscription);

  const [open, setOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const search = useDebounced(query, SEARCH_DEBOUNCE_MS).trim();
  const needle = query.trim().toLowerCase();

  /**
   * Set when a selection navigated, so the dialog does not throw focus back at a control on the
   * page it just left. Radix restores focus to whatever was focused when the palette opened,
   * which is exactly right for Escape and exactly wrong after a route change.
   */
  const navigated = React.useRef(false);

  // ── data ─────────────────────────────────────────────────────────────────────────────
  // Both queries are already in flight for most of the app — the sidebar renders the review
  // badge from `attention`, and `me.current` backs every screen that formats money — so opening
  // the palette costs a request only for the subscription search.
  const me = api.me.current.useQuery();
  const attention = api.dashboard.attention.useQuery();
  const results = api.subscriptions.list.useQuery(
    { search, limit: RESULT_LIMIT, sort: 'name', direction: 'asc' },
    {
      enabled: open && search !== '',
      // The previous matches stay on screen while the next query resolves. Without it the list
      // empties on every keystroke and the row under the cursor moves out from under it.
      placeholderData: keepPreviousData,
    },
  );

  const locale = me.data?.locale ?? 'en-GB';
  const reviewCount = attention.data?.pendingDetectionCount ?? 0;
  const subscriptions = search === '' ? [] : (results.data?.items ?? []);

  // ── navigation ───────────────────────────────────────────────────────────────────────
  const go = React.useCallback(
    (href: string) => {
      navigated.current = true;
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  const navRows = React.useMemo<readonly CommandRow[]>(
    () =>
      NAV_ROUTES.map((route) => ({
        id: `nav:${route.href}`,
        label: route.label,
        icon: route.icon,
        keywords: [route.href.replace('/', '')],
        perform: () => {
          go(route.href);
        },
      })),
    [go],
  );

  const actionRows = React.useMemo<readonly CommandRow[]>(
    () => [
      {
        id: 'action:new',
        label: 'Add a subscription',
        icon: Plus,
        keywords: ['new', 'create', 'track'],
        perform: () => {
          // The form is the subscriptions table's own; the table opens it when it next mounts.
          requestNewSubscription();
          go('/subscriptions');
        },
      },
      {
        id: 'action:import',
        label: 'Import CSV',
        icon: FileUp,
        keywords: ['upload', 'spreadsheet', 'csv'],
        perform: () => {
          go('/subscriptions/import');
        },
      },
      {
        id: 'action:connect',
        label: 'Connect a bank',
        icon: Link2,
        keywords: ['link', 'account', 'plaid'],
        perform: () => {
          go('/connections');
        },
      },
      {
        id: 'action:cancel',
        label: 'Start a cancellation',
        icon: Slash,
        keywords: ['cancel', 'quit', 'stop'],
        perform: () => {
          go('/subscriptions');
        },
      },
      {
        id: 'action:export',
        label: 'Export my data',
        icon: Download,
        keywords: ['download', 'json', 'csv', 'backup'],
        perform: () => {
          go('/settings');
        },
      },
      {
        id: 'action:review',
        label: 'Go to review',
        icon: Inbox,
        keywords: ['suggestions', 'detections', 'queue'],
        perform: () => {
          go('/review');
        },
      },
      {
        id: 'action:shortcuts',
        label: 'Keyboard shortcuts',
        icon: Keyboard,
        keywords: ['keys', 'bindings', 'help'],
        meta: '?',
        perform: () => {
          navigated.current = false;
          setOpen(false);
          setShortcutsOpen(true);
        },
      },
    ],
    [go, requestNewSubscription],
  );

  const shownNav = navRows.filter((row) => matches(needle, row.label, row.keywords));
  const shownActions = actionRows.filter((row) => matches(needle, row.label, row.keywords));

  /**
   * The review row sits above everything when there is a queue. It is the one entry that is not
   * navigation or a command but a fact about the account, and the fact is usually why the
   * palette was opened. `--control`, never `--alert`: a queue with work in it is work.
   */
  const showReview =
    reviewCount > 0 && matches(needle, 'Review suggestions', ['detections', 'queue', 'waiting']);

  const resultCount =
    (showReview ? 1 : 0) + shownNav.length + subscriptions.length + shownActions.length;

  // ── the bindings ─────────────────────────────────────────────────────────────────────
  React.useEffect(() => {
    function onOpenRequest(): void {
      setOpen(true);
    }
    function onShortcutsRequest(): void {
      setShortcutsOpen(true);
    }
    window.addEventListener(COMMAND_MENU_EVENT, onOpenRequest);
    window.addEventListener(SHORTCUTS_EVENT, onShortcutsRequest);
    return () => {
      window.removeEventListener(COMMAND_MENU_EVENT, onOpenRequest);
      window.removeEventListener(SHORTCUTS_EVENT, onShortcutsRequest);
    };
  }, []);

  React.useEffect(() => {
    /** Whether `g` is waiting for the second half of a go-to chord. */
    let chordTimer: ReturnType<typeof setTimeout> | null = null;
    let armed = false;

    function disarm(): void {
      armed = false;
      if (chordTimer !== null) clearTimeout(chordTimer);
      chordTimer = null;
    }

    function onKeyDown(event: KeyboardEvent): void {
      // ⌘K first, and before every guard below it: it is the way *out* of the palette as well as
      // the way in, so it has to survive the palette's own input having focus.
      if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')) {
        // Browsers bind ⌘K to the address bar; the app claims it, as every palette does.
        event.preventDefault();
        disarm();
        navigated.current = false;
        setOpen((current) => !current);
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      // An overlay owns the keyboard while it is up. Navigating the page underneath a dialog is
      // never what the person holding it open meant.
      if (open || shortcutsOpen) return;

      if (event.key === '?') {
        event.preventDefault();
        disarm();
        setShortcutsOpen(true);
        return;
      }

      if (armed) {
        const destination = { d: '/', s: '/subscriptions', r: '/review' }[event.key.toLowerCase()];
        disarm();
        if (destination !== undefined) {
          event.preventDefault();
          router.push(destination);
        }
        return;
      }

      if (event.key === 'g' || event.key === 'G') {
        event.preventDefault();
        armed = true;
        // Disarmed on a timer rather than left standing: a `g` typed by accident should not turn
        // the next `d` — half an hour later, in a different screen — into a navigation.
        chordTimer = setTimeout(disarm, CHORD_WINDOW_MS);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      disarm();
    };
  }, [open, router, shortcutsOpen]);

  // The next opening starts from an empty field. Carrying the last search over means the palette
  // opens showing six rows about whatever the user was doing before, and the count read out to a
  // screen reader describes a query nobody just typed.
  React.useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  function renderRow(row: CommandRow): React.ReactNode {
    const Icon = row.icon;
    return (
      <CommandItem key={row.id} value={row.id} onSelect={row.perform}>
        <Icon aria-hidden className="size-4 shrink-0 text-text-3" strokeWidth={1.75} />
        <span className="truncate">{row.label}</span>
        {row.meta === undefined ? null : <CommandMeta>{row.meta}</CommandMeta>}
      </CommandItem>
    );
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) navigated.current = false;
          setOpen(next);
        }}
      >
        <DialogContent
          showClose={false}
          className="top-[10dvh] max-w-xl translate-y-0 p-0"
          onCloseAutoFocus={(event) => {
            if (!navigated.current) return;
            // Focus follows the navigation instead of snapping back to a control on the previous
            // screen. `#content` is the shell's main region and is already focusable for the
            // skip link, so this lands a screen reader at the top of the page that just loaded.
            event.preventDefault();
            navigated.current = false;
            document.getElementById('content')?.focus();
          }}
        >
          <DialogTitle className="sr-only">Search and commands</DialogTitle>
          <DialogDescription className="sr-only">
            Search your subscriptions, jump to a screen, or run an action.
          </DialogDescription>

          <Command shouldFilter={false} label="Search and commands">
            <CommandInput
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search subscriptions, or type a command"
            />

            {/*
              The count, for people who cannot see the list change. Outside `CommandList` so the
              live region is not itself a listbox child, and polite so it waits for the pause
              between keystrokes rather than interrupting every one of them.
            */}
            <p role="status" aria-live="polite" className="sr-only">
              {resultCount === 0
                ? 'No results'
                : `${resultCount} result${resultCount === 1 ? '' : 's'}`}
            </p>

            <CommandList>
              {resultCount === 0 ? (
                <CommandEmpty>Nothing matches that. Try a merchant name.</CommandEmpty>
              ) : null}

              {showReview ? (
                <CommandGroup heading="Waiting for you">
                  <CommandItem
                    value="review:queue"
                    onSelect={() => {
                      go('/review');
                    }}
                  >
                    <Inbox aria-hidden className="size-4 shrink-0 text-text-3" strokeWidth={1.75} />
                    <span className="truncate">
                      Review {reviewCount} suggestion{reviewCount === 1 ? '' : 's'}
                    </span>
                  </CommandItem>
                </CommandGroup>
              ) : null}

              {shownNav.length > 0 ? (
                <CommandGroup heading="Go to">{shownNav.map(renderRow)}</CommandGroup>
              ) : null}

              {subscriptions.length > 0 ? (
                <CommandGroup heading="Subscriptions">
                  {subscriptions.map((entry) => (
                    <CommandItem
                      key={entry.subscription.id}
                      value={`subscription:${entry.subscription.id}`}
                      onSelect={() => {
                        go(`/subscriptions/${entry.subscription.id}`);
                      }}
                    >
                      <span className="truncate">{entry.subscription.displayName}</span>
                      <CommandMeta className="flex items-center gap-2">
                        <Money
                          amountMinor={entry.subscription.amountMinor}
                          currency={entry.subscription.currency}
                          tone="outflow"
                          size="sm"
                          locale={locale}
                        />
                        <span>
                          {intervalLabel(
                            interval(entry.subscription.intervalUnit, entry.subscription.intervalCount),
                          )}
                        </span>
                      </CommandMeta>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              {shownActions.length > 0 ? (
                <CommandGroup heading="Do">{shownActions.map(renderRow)}</CommandGroup>
              ) : null}
            </CommandList>

            <div className="flex shrink-0 items-center gap-3 border-t border-line px-[var(--pad-panel)] py-2 text-[0.6875rem] text-text-3">
              <span>
                <kbd className="font-mono">↑↓</kbd> move
              </span>
              <span>
                <kbd className="font-mono">Enter</kbd> open
              </span>
              <span className="ml-auto hidden sm:inline">
                <kbd className="font-mono">{modifier}K</kbd> closes this
              </span>
            </div>
          </Command>
        </DialogContent>
      </Dialog>

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  );
}
