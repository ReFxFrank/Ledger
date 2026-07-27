'use client';

import { useEffect, useState } from 'react';

/**
 * Everything the app's keyboard layer agrees on: the two open signals, the guard that decides
 * whether a bare keystroke belongs to the app or to whatever the user is typing in, and the
 * binding table the reference dialog renders.
 *
 * The table is here rather than in the dialog because it is documentation of behaviour that
 * lives in five other files — the palette below, `components/subscriptions/table.tsx`, and
 * `components/review/queue.tsx`. It cannot enforce that they agree, but it can at least be the
 * one place someone changing a binding is obliged to walk past.
 */

/** Open the command palette. Dispatched by the top bar's ⌘K control. */
export const COMMAND_MENU_EVENT = 'ledger:command-menu';

/** Open the shortcuts reference. Dispatched by the top bar's `?` control. */
export const SHORTCUTS_EVENT = 'ledger:shortcuts';

export function openCommandMenu(): void {
  window.dispatchEvent(new CustomEvent(COMMAND_MENU_EVENT));
}

export function openShortcuts(): void {
  window.dispatchEvent(new CustomEvent(SHORTCUTS_EVENT));
}

/**
 * Whether a keystroke is going into text.
 *
 * Every unmodified single-key binding in the app checks this first. Without it, `?` on a keyboard
 * shortcut list is a keyboard shortcut list that opens while you are typing a question into the
 * notes field — and the fix people reach for then is to remove the shortcut, not the bug.
 *
 * `<select>` is included: it is not text, but it consumes letter keys to jump between options,
 * and stealing those breaks a control that never advertised itself as needing protection.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** ⌘ on Apple hardware, Ctrl everywhere else. Resolved after mount to keep SSR output stable. */
export function useModifierLabel(): string {
  const [label, setLabel] = useState('Ctrl');
  useEffect(() => {
    // User agent rather than `navigator.platform`, which is deprecated and frozen in some
    // browsers. iPadOS reports as a Mac and takes ⌘ too, so the loose match is the right one.
    if (/Mac|iPhone|iPad|iPod/u.test(navigator.userAgent)) setLabel('⌘');
  }, []);
  return label;
}

export interface Binding {
  /** Rendered as separate keycaps. `MOD` is substituted with ⌘ or Ctrl at render time. */
  readonly keys: readonly string[];
  /** How the keycaps combine: pressed together, or one after the other. */
  readonly chord?: boolean;
  readonly description: string;
}

export interface BindingGroup {
  readonly title: string;
  /** Where it applies, when that is not obvious from the title. */
  readonly note?: string;
  readonly bindings: readonly Binding[];
}

/** Substituted into `Binding.keys` so one table serves both platforms. */
export const MOD_PLACEHOLDER = 'MOD';

export const SHORTCUT_GROUPS: readonly BindingGroup[] = [
  {
    title: 'Anywhere',
    bindings: [
      { keys: [MOD_PLACEHOLDER, 'K'], description: 'Open the command palette' },
      { keys: ['?'], description: 'Show this list' },
      { keys: ['Esc'], description: 'Close the palette or a dialog' },
      { keys: ['G', 'D'], chord: true, description: 'Go to the dashboard' },
      { keys: ['G', 'S'], chord: true, description: 'Go to subscriptions' },
      { keys: ['G', 'R'], chord: true, description: 'Go to review' },
    ],
  },
  {
    title: 'In the palette',
    bindings: [
      { keys: ['↑', '↓'], description: 'Move through the results' },
      { keys: ['Enter'], description: 'Open the highlighted result' },
    ],
  },
  {
    title: 'Subscriptions',
    note: 'On the subscriptions table.',
    bindings: [
      { keys: ['/'], description: 'Focus the search' },
      { keys: ['↑', '↓'], description: 'Move between rows' },
      { keys: ['Space'], description: 'Select the row' },
      { keys: ['Enter'], description: 'Open the subscription' },
      { keys: ['Esc'], description: 'Clear the selection' },
    ],
  },
  {
    title: 'Review',
    note: 'On the detection queue.',
    bindings: [
      { keys: ['J', 'K'], description: 'Move between suggestions' },
      { keys: ['Y'], description: 'Confirm the suggestion' },
      { keys: ['N'], description: 'Dismiss it' },
      { keys: ['E'], description: 'Edit before confirming' },
      { keys: ['M'], description: 'Merge into a subscription you already track' },
      { keys: ['Enter'], description: 'Show the charges behind it' },
      { keys: ['Space'], description: 'Add it to the bulk selection' },
    ],
  },
];
