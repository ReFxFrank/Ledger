import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ConnectionsScreen } from '~/components/connections/screen';

export const metadata: Metadata = {
  title: 'Connections',
  description: 'Where the transactions come from, and what still has permission to send them.',
};

/**
 * Bank connections and payment methods.
 *
 * Two promises are made on this screen and both are kept by the code behind it: Ledger never asks
 * for a bank password, and the aggregator token it does hold is sealed by @ledger/crypto before
 * it reaches the database. Nothing on this page can show you a token, because no procedure that
 * feeds it returns one.
 */
export default function ConnectionsPage(): ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-[var(--gap-loose)] p-[var(--pad-panel)]">
      <header className="min-w-0">
        <p className="eyebrow">Connections</p>
        <h1 className="mt-1 text-lg font-medium leading-tight text-text">Where the data comes from</h1>
        <p className="mt-1.5 max-w-prose text-xs text-text-2">
          Ledger never asks for your bank sign-in and never logs in as you. A connection is
          permission you grant your bank to share read-only transaction data, and it expires on
          your bank&rsquo;s clock — which is why the countdown is on this screen before it runs out.
        </p>
      </header>

      <ConnectionsScreen />
    </div>
  );
}
