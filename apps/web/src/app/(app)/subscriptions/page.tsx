import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SubscriptionsTable } from '~/components/subscriptions/table';

export const metadata: Metadata = {
  title: 'Subscriptions',
  description: 'Everything charging you, on one screen.',
};

/**
 * The subscriptions screen.
 *
 * A server component wrapping one client island. There is nothing worth prefetching here that
 * the table does not already need in the browser — filters, sorting, selection and inline edits
 * all live client side — so the server's job is the heading and the shell, and nothing more.
 */
export default function SubscriptionsPage(): ReactNode {
  return (
    <div className="flex min-h-0 flex-col gap-[var(--gap-loose)] p-[var(--pad-panel)]">
      <header className="flex flex-wrap items-end justify-between gap-[var(--gap)]">
        <div className="min-w-0">
          <p className="eyebrow">Subscriptions</p>
          <h1 className="mt-1 text-lg font-medium leading-tight text-text">Everything charging you</h1>
        </div>
        {/* The shortcuts are advertised once, here, rather than hidden behind a help icon. */}
        <p className="max-w-prose text-xs text-text-2">
          Arrow keys move, Space selects, Enter opens, E edits.{' '}
          <kbd className="rounded-sm border border-line px-1 font-mono text-[0.6875rem]">/</kbd> searches.
        </p>
      </header>

      <SubscriptionsTable />
    </div>
  );
}
