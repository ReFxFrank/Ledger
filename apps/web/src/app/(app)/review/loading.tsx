import * as React from 'react';
import { Skeleton } from '@ledger/ui';
import { ReviewSkeleton } from '~/components/review/skeleton';

/**
 * Route-level placeholder, shown while the page chunk streams in.
 *
 * The same skeleton the island uses for its own fetch, under the same heading block, so the
 * hand-off from "route loading" to "data loading" is invisible rather than a second flash.
 */
export default function ReviewLoading(): React.ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-[var(--gap-loose)] p-[var(--pad-panel)]">
      <div>
        <p className="eyebrow">Review</p>
        <Skeleton className="mt-1.5 h-5 w-64" />
        <Skeleton className="mt-2 h-3 w-full max-w-prose" />
      </div>
      <ReviewSkeleton />
    </div>
  );
}
