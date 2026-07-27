'use client';

import type { ReactNode } from 'react';
import { CommandPalette } from '../command-palette';
import { PageTitleProvider } from './page-title';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';

export interface AppShellProps {
  readonly name: string;
  readonly email: string;
  readonly children: ReactNode;
}

/**
 * The persistent frame: rail on the left, bar across the top, scrolling content between them.
 *
 * The skip link is first in the DOM and only visible on focus. It is not decoration — the rail
 * is eight links plus a top bar, and without it every keyboard user pays that toll on every
 * navigation.
 *
 * `pb-16` on the content column clears the mobile bottom bar, which is fixed and would otherwise
 * cover the last row of a table on exactly the device where the last row is hardest to reach.
 *
 * The command palette mounts here, once, rather than on each screen: it owns the app's global
 * key bindings, and one instance per route would mean N handlers racing for the same keystroke.
 */
export function AppShell({ name, email, children }: AppShellProps): ReactNode {
  return (
    <PageTitleProvider>
      <a
        href="#content"
        className="sr-only rounded-md border border-control bg-ink-800 px-3 py-2 text-sm text-text focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50"
      >
        Skip to content
      </a>

      <div className="flex min-h-dvh">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar name={name} email={email} />
          <main id="content" tabIndex={-1} className="flex-1 pb-16 outline-none md:pb-0">
            {children}
          </main>
        </div>
      </div>

      <CommandPalette />
    </PageTitleProvider>
  );
}
