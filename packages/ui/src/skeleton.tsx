'use client';

import * as React from 'react';
import { cn } from './lib/cn';

/**
 * Loading placeholder.
 *
 * Under reduced motion the pulse stops entirely — unlike a spinner, a static grey block still
 * reads as "not here yet", so there is nothing to preserve by animating it.
 */
export const Skeleton = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  function Skeleton({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        aria-hidden
        className={cn('animate-pulse rounded-sm bg-ink-600 motion-reduce:animate-none', className)}
        {...props}
      />
    );
  },
);

export interface SkeletonTextProps extends React.ComponentPropsWithoutRef<'div'> {
  readonly lines?: number;
}

/** A few stacked bars, last one short, so a loading paragraph looks like a paragraph. */
export const SkeletonText = React.forwardRef<HTMLDivElement, SkeletonTextProps>(function SkeletonText(
  { className, lines = 3, ...props },
  ref,
) {
  return (
    <div ref={ref} className={cn('flex flex-col gap-[var(--gap-tight)]', className)} {...props}>
      {Array.from({ length: Math.max(1, lines) }, (_unused, index) => (
        <Skeleton key={index} className={cn('h-3', index === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
});
