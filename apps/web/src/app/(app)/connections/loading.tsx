import * as React from 'react';
import { Skeleton } from '@ledger/ui';
import { ConnectionsSkeleton } from '~/components/connections/skeleton';

/** Route-level placeholder — the same two panels the loaded screen settles into. */
export default function ConnectionsLoading(): React.ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-[var(--gap-loose)] p-[var(--pad-panel)]">
      <div>
        <p className="eyebrow">Connections</p>
        <Skeleton className="mt-1.5 h-5 w-56" />
        <Skeleton className="mt-2 h-3 w-full max-w-prose" />
      </div>
      <ConnectionsSkeleton />
    </div>
  );
}
