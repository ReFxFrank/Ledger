'use client';

import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from './lib/cn';

export interface LabelProps extends React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> {
  /**
   * Marks the field required. The asterisk is decorative — set `required` on the control too,
   * because a red star is not an accessible name for anything.
   */
  readonly required?: boolean;
}

export const Label = React.forwardRef<React.ComponentRef<typeof LabelPrimitive.Root>, LabelProps>(
  function Label({ className, required = false, children, ...props }, ref) {
    return (
      <LabelPrimitive.Root
        ref={ref}
        className={cn(
          'inline-flex items-center gap-1 text-xs font-medium leading-none text-text-2',
          'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
          className,
        )}
        {...props}
      >
        {children}
        {required ? (
          <span aria-hidden className="text-outflow">
            *
          </span>
        ) : null}
      </LabelPrimitive.Root>
    );
  },
);
