import * as React from 'react';
import { Skeleton } from '@ledger/ui';
import { AnalyticsSkeleton } from '~/components/analytics/skeleton';

/** Route-level placeholder — the same panel grid the loaded screen settles into. */
export default function AnalyticsLoading(): React.ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-[var(--gap-loose)] p-[var(--pad-panel)]">
      <div>
        <p className="eyebrow">Analytics</p>
        <Skeleton className="mt-1.5 h-5 w-52" />
        <Skeleton className="mt-2 h-3 w-full max-w-prose" />
      </div>
      <AnalyticsSkeleton />
    </div>
  );
}
