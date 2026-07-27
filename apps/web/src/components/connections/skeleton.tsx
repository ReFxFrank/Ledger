'use client';

import * as React from 'react';
import { Panel, PanelBody, PanelHeader, Skeleton } from '@ledger/ui';

/** The connections screen before its two queries land. Same panels, same row heights. */
export function ConnectionsSkeleton(): React.ReactNode {
  return (
    <div className="flex flex-col gap-[var(--gap-loose)]">
      <Panel>
        <PanelHeader eyebrow="Bank connections" actions={<Skeleton className="h-7 w-32" />}>
          <Skeleton className="h-4 w-60" />
        </PanelHeader>
        <PanelBody className="flex flex-col gap-[var(--gap)]">
          {[0, 1].map((card) => (
            <div key={card} className="rounded-md border border-line bg-ink-700 p-[var(--pad-card)]">
              <div className="flex items-start justify-between gap-[var(--gap)]">
                <div className="flex items-center gap-2.5">
                  <Skeleton className="size-7 rounded-sm" />
                  <div>
                    <Skeleton className="h-4 w-36" />
                    <Skeleton className="mt-2 h-3 w-28" />
                  </div>
                </div>
                <Skeleton className="h-5 w-24" />
              </div>
              <Skeleton className="mt-[var(--gap-loose)] h-10 w-full" />
              <Skeleton className="mt-1.5 h-10 w-full" />
            </div>
          ))}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader eyebrow="Payment methods">
          <Skeleton className="h-4 w-48" />
        </PanelHeader>
        <PanelBody className="flex flex-col gap-1.5">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-12 w-full" />
          ))}
        </PanelBody>
      </Panel>
    </div>
  );
}
