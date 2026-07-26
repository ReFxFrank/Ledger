'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import { cn, focusRing } from './lib/cn';

/**
 * Checkbox. The indeterminate state renders a dash, which the bulk-select header row in the
 * subscriptions table needs — "some of 47 rows" is not a checked box and not an empty one.
 */
export const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        'peer grid size-4 shrink-0 place-items-center rounded-sm border border-line-strong bg-ink-900',
        'transition-[background-color,border-color] duration-[var(--duration-fast)] ease-standard',
        'hover:border-line-hot disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:border-control data-[state=checked]:bg-control',
        'data-[state=indeterminate]:border-control data-[state=indeterminate]:bg-control',
        focusRing,
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center text-ink-900">
        {props.checked === 'indeterminate' ? (
          <Minus className="size-3" strokeWidth={3} aria-hidden />
        ) : (
          <Check className="size-3" strokeWidth={3} aria-hidden />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});
