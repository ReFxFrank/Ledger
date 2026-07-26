'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn, focusRing } from './lib/cn';

/**
 * Switch — for settings that take effect immediately. If the change needs a Save button, use a
 * checkbox instead: a toggle that has not applied yet is the control users misread most often.
 */
export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 items-center rounded-lg border border-line-strong bg-ink-600 p-0.5',
        'transition-[background-color,border-color] duration-[var(--duration-fast)] ease-standard',
        'hover:border-line-hot disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:border-control data-[state=checked]:bg-control',
        focusRing,
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'block size-3.5 rounded-lg bg-text shadow-card',
          'transition-transform duration-[var(--duration-fast)] ease-standard',
          'data-[state=checked]:translate-x-4 data-[state=checked]:bg-ink-900 data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  );
});
