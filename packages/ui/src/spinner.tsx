'use client';

import * as React from 'react';
import { cn } from './lib/cn';

export interface SpinnerProps extends React.ComponentPropsWithoutRef<'span'> {
  readonly size?: 'sm' | 'md';
  /** Announced to screen readers. Omit inside a button that already says what it is doing. */
  readonly label?: string;
}

/**
 * Indeterminate progress.
 *
 * Under reduced motion the rotation slows rather than stopping: a frozen spinner reads as a
 * crashed request, which is worse than the motion it was meant to spare.
 */
export const Spinner = React.forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { className, size = 'md', label, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      role={label === undefined ? 'presentation' : 'status'}
      aria-hidden={label === undefined ? true : undefined}
      className={cn('inline-flex items-center justify-center', className)}
      {...props}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        className={cn(
          'animate-spin motion-reduce:[animation-duration:1.6s]',
          size === 'sm' ? 'size-3' : 'size-4',
        )}
      >
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
        <path
          d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      {label === undefined ? null : <span className="sr-only">{label}</span>}
    </span>
  );
});
