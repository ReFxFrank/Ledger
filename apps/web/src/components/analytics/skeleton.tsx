'use client';

import * as React from 'react';
import { Panel, PanelBody, PanelHeader, Skeleton } from '@ledger/ui';

/**
 * The analytics screen before its five queries land.
 *
 * The proportions match the loaded page — two chart panels side by side from `xl`, the simulator
 * strip, then the ranked table — so the screen fills in rather than reflowing under the pointer.
 */
export function AnalyticsSkeleton(): React.ReactNode {
  return (
    <div className="flex flex-col gap-[var(--gap-loose)]">
      <div className="grid gap-[var(--gap-loose)] xl:grid-cols-2">
        {[0, 1].map((chart) => (
          <Panel key={chart}>
            <PanelHeader eyebrow="Loading" actions={<Skeleton className="h-7 w-28" />}>
              <Skeleton className="h-4 w-56" />
            </PanelHeader>
            <PanelBody>
              <Skeleton className="h-[200px] w-full" />
            </PanelBody>
          </Panel>
        ))}
      </div>

      <div className="grid gap-[var(--gap-loose)] xl:grid-cols-2">
        <Panel>
          <PanelHeader eyebrow="Loading">
            <Skeleton className="h-4 w-48" />
          </PanelHeader>
          <PanelBody>
            <Skeleton className="h-[200px] w-full" />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader eyebrow="Loading">
            <Skeleton className="h-4 w-44" />
          </PanelHeader>
          <PanelBody className="flex flex-col gap-2">
            <Skeleton className="h-3 w-full" />
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-4 w-full" />
            ))}
          </PanelBody>
        </Panel>
      </div>

      <Panel>
        <PanelHeader eyebrow="Cancel simulator">
          <Skeleton className="h-4 w-64" />
        </PanelHeader>
        <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-9 w-full" />
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-9 w-full" />
          ))}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader eyebrow="Cost per use" actions={<Skeleton className="h-6 w-40" />}>
          <Skeleton className="h-4 w-72" />
        </PanelHeader>
        <PanelBody className="flex flex-col gap-1.5">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <Skeleton key={row} className="h-8 w-full" />
          ))}
        </PanelBody>
      </Panel>
    </div>
  );
}
