'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from './lib/cn';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * Tooltips carry hints, never the only copy of a fact — they do not exist on touch and they are
 * gone the moment the pointer leaves. Anything a user must read to act belongs on the surface.
 */
export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          'z-50 max-w-64 rounded-md border border-line-strong bg-ink-700 px-2 py-1.5 text-xs leading-snug text-text shadow-overlay',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});
