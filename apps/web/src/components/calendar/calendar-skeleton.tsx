'use client';

import * as React from 'react';
import { Panel, PanelBody, PanelHeader, Skeleton } from '@ledger/ui';

/**
 * Six rows of seven, at the real cell height.
 *
 * The month grid is the tallest thing on the page, and a placeholder that is shorter than it
 * makes the whole page jump when the data lands. Matching the geometry exactly costs nothing.
 */
export function CalendarSkeleton(): React.ReactNode {
  return (
    <Panel>
      <PanelHeader eyebrow="Renewals" actions={<Skeleton className="h-7 w-32" />}>
        <Skeleton className="h-4 w-40" />
      </PanelHeader>
      <PanelBody className="p-[var(--gap-tight)]">
        <div className="grid grid-cols-7 gap-px pb-1">
          {Array.from({ length: 7 }, (_unused, index) => (
            <Skeleton key={index} className="mx-auto h-3 w-6" />
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md bg-line">
          {Array.from({ length: 42 }, (_unused, index) => (
            <div key={index} className="min-h-[62px] bg-ink-800 p-1.5 sm:min-h-[76px] sm:p-2">
              <Skeleton className="h-2.5 w-4" />
            </div>
          ))}
        </div>
      </PanelBody>
    </Panel>
  );
}
