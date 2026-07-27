import * as React from 'react';
import { CancellationDetailSkeleton } from '~/components/cancellations/skeletons';

/** The detail placeholder — the same two-column split the loaded page settles into. */
export default function CancellationDetailLoading(): React.ReactNode {
  return (
    <div className="mx-auto w-full max-w-[1200px] p-[var(--pad-panel)]">
      <CancellationDetailSkeleton />
    </div>
  );
}
