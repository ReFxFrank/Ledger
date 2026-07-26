'use client';

import type { ReactNode } from 'react';
import { Toaster, TooltipProvider } from '@ledger/ui';
import { TRPCProvider } from '~/lib/trpc';

/**
 * Everything the tree needs that has to run in the browser, in one client boundary.
 *
 * Mounted once at the root rather than per route group, so a toast fired during a navigation
 * survives the page it was fired from — the confirmation for "Cancellation started." outlives
 * the screen that started it, which is the point of a toast.
 */
export function Providers({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <TRPCProvider>
      {/*
        600ms before a tooltip opens: long enough that a pointer crossing a dense toolbar does
        not trail popovers behind it, short enough to feel like an answer rather than a delay.
      */}
      <TooltipProvider delayDuration={600} skipDelayDuration={300}>
        {children}
        <Toaster />
      </TooltipProvider>
    </TRPCProvider>
  );
}
