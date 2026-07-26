'use client';

import type { ReactNode } from 'react';
import { AccountMenu } from './account-menu';
import { CommandTrigger } from './command-trigger';
import { NotificationBell } from './notification-bell';
import { useResolvedPageTitle } from './page-title';

export interface TopBarProps {
  readonly name: string;
  readonly email: string;
}

/**
 * The bar above every screen: where you are, then the three things you can do from anywhere.
 *
 * The title is an `<h1>` and the only one on the page — screens render their own section
 * headings from `<h2>` down, so the document outline matches what the eye sees.
 *
 * Sticky rather than fixed: it keeps its place in the flow, so the content below it does not
 * need a magic top offset that goes stale the first time this row changes height.
 */
export function TopBar({ name, email }: TopBarProps): ReactNode {
  const title = useResolvedPageTitle();

  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-[var(--gap)] border-b border-line bg-ink-900/95 px-[var(--pad-panel)] backdrop-blur-sm">
      {/* Truncates rather than wraps: a long merchant name must not push the bar to two rows. */}
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium tracking-tight text-text">{title}</h1>

      <CommandTrigger />
      <NotificationBell />
      <AccountMenu name={name} email={email} />
    </header>
  );
}
