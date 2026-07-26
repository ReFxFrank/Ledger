'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn, focusRing } from './lib/cn';

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        // Scrolls rather than wraps: at 375px a wrapped tab strip changes height as you switch
        // tabs, which shifts the content underneath it.
        'inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-line bg-ink-800 p-0.5',
        className,
      )}
      {...props}
    />
  );
});

export const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-xs font-medium text-text-2',
        'transition-[background-color,color] duration-[var(--duration-fast)] ease-standard',
        'hover:text-text data-[state=active]:bg-ink-500 data-[state=active]:text-text',
        'disabled:pointer-events-none disabled:opacity-50',
        focusRing,
        className,
      )}
      {...props}
    />
  );
});

export const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return <TabsPrimitive.Content ref={ref} className={cn('mt-[var(--gap-loose)]', focusRing, className)} {...props} />;
});
