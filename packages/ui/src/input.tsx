'use client';

import * as React from 'react';
import { cn, focusRing } from './lib/cn';

export interface InputProps extends React.ComponentPropsWithoutRef<'input'> {
  /**
   * Mono, tabular figures. Set it for amounts, dates, account numbers and bank descriptors —
   * anything the user will compare down a column rather than read as a sentence.
   */
  readonly mono?: boolean;
}

/**
 * Text input.
 *
 * The field recesses to `--ink-900`, one step below the panel it sits in, so a form reads as
 * holes cut in the surface rather than as more cards. `aria-invalid` drives the error border:
 * the accessible state and the visible state cannot drift apart if they are the same attribute.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, mono = false, type = 'text', ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        'h-9 w-full rounded-md border border-line-strong bg-ink-900 px-2.5 text-sm text-text',
        'placeholder:text-text-3 disabled:cursor-not-allowed disabled:opacity-50',
        'transition-[border-color] duration-[var(--duration-fast)] ease-standard hover:border-line-hot',
        'aria-[invalid=true]:border-alert',
        mono && 'font-mono tabular-nums',
        focusRing,
        className,
      )}
      {...props}
    />
  );
});
