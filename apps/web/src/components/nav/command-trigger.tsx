'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@ledger/ui';

/**
 * The ⌘K affordance.
 *
 * The palette itself is not built here — this is the handle it hangs on. Clicking the control,
 * or pressing ⌘K / Ctrl+K anywhere in the app, dispatches `COMMAND_MENU_EVENT` on `window`;
 * whoever owns the palette listens for it and opens. One event means the shortcut and the
 * button cannot drift apart, and the affordance is visible from day one rather than being a
 * shortcut only the people who built it know exists.
 */
export const COMMAND_MENU_EVENT = 'ledger:command-menu';

export function openCommandMenu(): void {
  window.dispatchEvent(new CustomEvent(COMMAND_MENU_EVENT));
}

/** ⌘ on Apple hardware, Ctrl everywhere else. Resolved after mount to keep SSR output stable. */
function useModifierLabel(): string {
  const [label, setLabel] = useState('Ctrl');
  useEffect(() => {
    // User agent rather than `navigator.platform`, which is deprecated and frozen in some
    // browsers. iPadOS reports as a Mac and takes ⌘ too, so the loose match is the right one.
    if (/Mac|iPhone|iPad|iPod/u.test(navigator.userAgent)) setLabel('⌘');
  }, []);
  return label;
}

export function CommandTrigger(): ReactNode {
  const modifier = useModifierLabel();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'k' && event.key !== 'K') return;
      if (!event.metaKey && !event.ctrlKey) return;
      // Browsers bind ⌘K to the address bar; the app claims it, as every palette does.
      event.preventDefault();
      openCommandMenu();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
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
  );
}
