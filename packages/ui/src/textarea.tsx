'use client';

import * as React from 'react';
import { cn, focusRing } from './lib/cn';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentPropsWithoutRef<'textarea'>>(
  function Textarea({ className, rows = 3, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn(
          'w-full resize-y rounded-md border border-line-strong bg-ink-900 px-2.5 py-2 text-sm leading-relaxed text-text',
          'placeholder:text-text-3 disabled:cursor-not-allowed disabled:opacity-50',
          'transition-[border-color] duration-[var(--duration-fast)] ease-standard hover:border-line-hot',
          'aria-[invalid=true]:border-alert',
          focusRing,
          className,
        )}
        {...props}
      />
    );
  },
);
