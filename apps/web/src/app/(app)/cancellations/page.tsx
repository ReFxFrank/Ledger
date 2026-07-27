import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CancellationBoard } from '~/components/cancellations/board';

export const metadata: Metadata = {
  title: 'Cancellations',
  description: 'What you are getting out of, and by when.',
};

/**
 * The cancellation board.
 *
 * The heading says what the product does and, just as importantly, what it does not: Ledger
 * knows the exit and holds the deadline. The user is the one who cancels.
 */
export default function CancellationsPage(): ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-[var(--gap-loose)] p-[var(--pad-panel)]">
      <header className="min-w-0">
        <p className="eyebrow">Cancellations</p>
        <h1 className="mt-1 text-lg font-medium leading-tight text-text">What you are getting out of</h1>
        <p className="mt-1.5 max-w-prose text-xs text-text-2">
          Ledger never cancels anything for you. It works out where the exit actually is, holds the
          date you have to act by, keeps the record, and then checks your bank feed to see whether
          the charge really stopped.
        </p>
      </header>

      <CancellationBoard />
    </div>
  );
}
