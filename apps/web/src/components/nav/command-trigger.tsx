'use client';

import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@ledger/ui';
import { openCommandMenu, openShortcuts, useModifierLabel } from '~/lib/keyboard';

/**
 * The ⌘K affordance, and the `?` next to it.
 *
 * Neither control binds a key. `CommandPalette` owns every global binding in the app and these
 * two dispatch to it, so the button and the keystroke cannot drift apart and no keystroke ends
 * up with two handlers. What lives here is discoverability: the palette exists whether or not
 * anyone guesses ⌘K, and the shortcut list is reachable without already knowing a shortcut.
 *
 * The `?` control is hidden below `sm`. It advertises a keyboard, and the device that hides it
 * does not have one — at 375px the row it would join is a title, a search, a bell and an avatar.
 */
export function CommandTrigger(): ReactNode {
  const modifier = useModifierLabel();

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={openCommandMenu}
        className={cn(
          'group flex h-7 items-center gap-2 rounded-md border border-line-strong bg-ink-900 pl-2 pr-1.5',
          'text-xs text-text-3 outline-none',
          'transition-[border-color,color] duration-[var(--duration-fast)] ease-standard',
          'hover:border-line-hot hover:text-text-2 focus-visible:[box-shadow:var(--focus-ring)]',
        )}
      >
        <Search aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
        {/* The word is hidden on narrow screens; the icon and the accessible name carry it. */}
        <span className="hidden sm:inline">Search</span>
        <kbd
          aria-hidden
          className="ml-1 hidden rounded-sm border border-line bg-ink-700 px-1 font-mono text-[0.625rem] leading-4 text-text-3 sm:inline"
        >
          {modifier}K
        </kbd>
        <span className="sr-only">Search and commands, keyboard shortcut {modifier} K</span>
      </button>

      <button
        type="button"
        onClick={openShortcuts}
        aria-label="Keyboard shortcuts"
        className={cn(
          'hidden size-7 shrink-0 place-items-center rounded-md border border-transparent',
          'font-mono text-xs text-text-3 outline-none sm:grid',
          'transition-[border-color,color] duration-[var(--duration-fast)] ease-standard',
          'hover:border-line-hot hover:text-text-2 focus-visible:[box-shadow:var(--focus-ring)]',
        )}
      >
        <span aria-hidden>?</span>
      </button>
    </div>
  );
}
