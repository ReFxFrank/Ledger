import * as React from 'react';
import { Skeleton } from '@ledger/ui';
import { CancellationBoardSkeleton } from '~/components/cancellations/skeletons';

/** The board's route-level placeholder — same columns, same card heights, so nothing jumps. */
export default function CancellationsLoading(): React.ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-[var(--gap-loose)] p-[var(--pad-panel)]">
      <div>
        <p className="eyebrow">Cancellations</p>
        <Skeleton className="mt-1.5 h-5 w-56" />
        <Skeleton className="mt-2 h-3 w-full max-w-prose" />
      </div>
      <CancellationBoardSkeleton />
    </div>
  );
}
