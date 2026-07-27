'use client';

import * as React from 'react';
import { Panel, PanelBody, PanelHeader, Skeleton } from '@ledger/ui';

/**
 * Placeholders for the cancellation surfaces.
 *
 * Both are built from the same panels, columns and card heights as the loaded screens, so the
 * layout settles into place rather than reflowing once the query resolves.
 */

export function CancellationBoardSkeleton(): React.ReactNode {
  return (
    <div className="grid gap-[var(--gap)] lg:grid-cols-4">
      {[0, 1, 2, 3].map((column) => (
        <Panel key={column} className="min-w-0">
          <PanelHeader eyebrow="Column">
            <Skeleton className="h-4 w-28" />
          </PanelHeader>
          <PanelBody className="flex flex-col gap-[var(--gap-tight)]">
            {Array.from({ length: column === 1 ? 3 : 1 }, (_unused, card) => (
              <div key={card} className="rounded-md border border-line bg-ink-700 p-[var(--pad-card)]">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-2 h-3 w-20" />
                <Skeleton className="mt-3 h-3 w-24" />
              </div>
            ))}
          </PanelBody>
        </Panel>
      ))}
    </div>
  );
}

export function CancellationDetailSkeleton(): React.ReactNode {
  return (
    <div className="flex flex-col gap-[var(--gap-loose)]">
      <Panel>
        <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
          <Skeleton className="h-5 w-52" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-4 w-64" />
        </PanelBody>
      </Panel>

      <div className="grid gap-[var(--gap-loose)] lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-[var(--gap-loose)]">
          <Panel>
            <PanelHeader eyebrow="Checklist" />
            <PanelBody className="flex flex-col gap-[var(--gap-tight)]">
              {[0, 1, 2, 3, 4].map((step) => (
                <Skeleton key={step} className="h-12 w-full" />
              ))}
            </PanelBody>
          </Panel>
        </div>

        <div className="flex flex-col gap-[var(--gap-loose)]">
          <Panel>
            <PanelHeader eyebrow="Deadline" />
            <PanelBody>
              <Skeleton className="h-8 w-32" />
              <Skeleton className="mt-3 h-3 w-full" />
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader eyebrow="Evidence" />
            <PanelBody>
              <Skeleton className="h-16 w-full" />
            </PanelBody>
          </Panel>
        </div>
      </div>
    </div>
  );
}
