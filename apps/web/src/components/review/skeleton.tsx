'use client';

import * as React from 'react';
import { Panel, PanelHeader, Skeleton } from '@ledger/ui';

/**
 * The review queue, before its data arrives.
 *
 * Built from the same panel, the same card padding and the same three-block card body as a real
 * candidate — header line, descriptor line, action row — so the queue settles into place instead
 * of reflowing under the pointer the moment the query resolves.
 */
export function ReviewSkeleton({ rows = 4 }: { readonly rows?: number }): React.ReactNode {
  return (
    <Panel>
      <PanelHeader eyebrow="Detected subscriptions" actions={<Skeleton className="h-7 w-44" />}>
        <Skeleton className="h-4 w-64" />
      </PanelHeader>

      <ul className="flex flex-col gap-[var(--gap)] p-[var(--pad-panel)]">
        {Array.from({ length: rows }, (_unused, index) => (
          <li key={index} className="rounded-md border border-line bg-ink-700 p-[var(--pad-card)]">
            <div className="flex items-start justify-between gap-[var(--gap)]">
              <div className="flex min-w-0 items-center gap-2.5">
                <Skeleton className="size-7 rounded-sm" />
                <div>
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="mt-2 h-3 w-24" />
                </div>
              </div>
              <Skeleton className="h-4 w-20" />
            </div>

            {/* The decoder line: one mono row of descriptor, one shorter normalised row. */}
            <Skeleton className="mt-[var(--gap-loose)] h-3.5 w-full max-w-[28rem]" />
            <Skeleton className="mt-2 h-3 w-40" />

            <div className="mt-[var(--gap-loose)] flex flex-wrap gap-[var(--gap-tight)]">
              <Skeleton className="h-7 w-24" />
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-7 w-36" />
              <Skeleton className="h-7 w-36" />
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
