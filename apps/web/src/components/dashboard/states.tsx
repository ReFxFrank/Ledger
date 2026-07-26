'use client';

import * as React from 'react';
import { Button, Panel, PanelBody, PanelHeader, Skeleton, cn } from '@ledger/ui';

/**
 * Loading and failure, shaped like the thing they stand in for.
 *
 * A skeleton whose proportions do not match the loaded layout is worse than no skeleton: the
 * page settles, then jumps, and the jump is what the user remembers. So each skeleton here is
 * built from the same panel and the same row heights as its real counterpart.
 *
 * Errors say what failed and offer the retry inline. "Something went wrong" tells the user
 * nothing they had not already worked out, and a page with no retry makes reloading the whole
 * app the only move available.
 */

export interface LoadErrorProps {
  /** What could not be loaded, lower case, as it reads mid-sentence: "the billing horizon". */
  readonly what: string;
  readonly error: { readonly message: string } | null;
  readonly onRetry: () => void;
  readonly retrying?: boolean;
  readonly className?: string;
}

export function LoadError({
  what,
  error,
  onRetry,
  retrying = false,
  className,
}: LoadErrorProps): React.ReactNode {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-start gap-[var(--gap-loose)] rounded-md border border-line bg-ink-700 p-[var(--pad-card)]',
        'sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <p className="text-sm text-text">Could not load {what}.</p>
        {error === null || error.message === '' ? null : (
          <p className="mt-1 text-xs text-text-2">{error.message}</p>
        )}
      </div>
      <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
        Try again
      </Button>
    </div>
  );
}

/** A panel-shaped error, for when the whole panel failed rather than one row inside it. */
export function PanelError({
  eyebrow,
  ...props
}: LoadErrorProps & { readonly eyebrow: string }): React.ReactNode {
  return (
    <Panel>
      <PanelHeader eyebrow={eyebrow} />
      <PanelBody>
        <LoadError {...props} />
      </PanelBody>
    </Panel>
  );
}

/**
 * The horizon skeleton.
 *
 * Bars of varied height rather than a flat block: the loaded chart is a ragged skyline, and a
 * uniform grey bar would resolve into something visibly different.
 */
const SKELETON_BARS = [34, 12, 58, 20, 76, 8, 44, 90, 16, 30, 62, 24, 48, 14, 70, 26, 40, 84, 18, 52];

export function BillingHorizonSkeleton(): React.ReactNode {
  return (
    <Panel>
      <PanelHeader
        eyebrow="Billing horizon"
        actions={<Skeleton className="h-5 w-24" />}
      >
        <Skeleton className="h-4 w-56" />
      </PanelHeader>
      <div className="px-[var(--pad-panel)] pb-[var(--pad-panel)] pt-[var(--gap-loose)]">
        <div className="flex h-[166px] items-end gap-1.5 border-b border-line-strong">
          {SKELETON_BARS.map((height, index) => (
            <Skeleton
              key={index}
              className="w-full max-w-[9px] rounded-[1.5px]"
              style={{ height: `${String(height)}%` }}
            />
          ))}
        </div>
        <Skeleton className="mt-[var(--gap-loose)] h-3 w-3/4" />
      </div>
    </Panel>
  );
}

export function SummarySkeleton(): React.ReactNode {
  return (
    <div className="grid gap-[var(--gap)] sm:grid-cols-3">
      {[0, 1, 2].map((index) => (
        <div key={index} className="rounded-md border border-line bg-ink-700 p-[var(--pad-card)]">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2.5 h-6 w-28" />
        </div>
      ))}
    </div>
  );
}

export function RowsSkeleton({ rows = 4 }: { readonly rows?: number }): React.ReactNode {
  return (
    <ul className="flex flex-col gap-[var(--gap-tight)]">
      {Array.from({ length: rows }, (_unused, index) => (
        <li
          key={index}
          className="flex items-center justify-between gap-[var(--gap)] rounded-md border border-line bg-ink-700 p-[var(--pad-card)]"
        >
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="mt-2 h-3 w-24" />
          </div>
          <Skeleton className="h-7 w-20" />
        </li>
      ))}
    </ul>
  );
}
