'use client';

import * as React from 'react';
import { Toaster as SonnerToaster, toast } from 'sonner';

export { toast };

/**
 * Toasts, themed to the tokens.
 *
 * Note what is missing: a green success toast. `--reclaim` belongs to the cancelled-savings
 * counter alone, so a confirmation here uses `--control` — the colour of something the user did.
 * `--alert` stays on the error variant, where the user genuinely has a problem.
 *
 * Classes carry the `!` suffix (Tailwind v4's important modifier) because sonner ships its own
 * stylesheet and would otherwise win on specificity for the shell.
 *
 * Mount once, in the root layout.
 */
export function Toaster({
  position = 'bottom-right',
  ...props
}: React.ComponentProps<typeof SonnerToaster>): React.ReactElement {
  return (
    <SonnerToaster
      theme="dark"
      position={position}
      gap={8}
      offset={16}
      toastOptions={{
        classNames: {
          toast: 'rounded-md! border! border-line-strong! bg-ink-700! text-text! shadow-overlay! font-sans! text-[0.8125rem]!',
          title: 'font-medium!',
          description: 'text-text-2! text-xs!',
          actionButton: 'rounded-sm! bg-control! text-ink-900! text-xs! font-medium!',
          cancelButton: 'rounded-sm! bg-ink-500! text-text-2! text-xs!',
          closeButton: 'border-line-strong! bg-ink-600! text-text-2!',
          success: 'text-control-2!',
          error: 'border-alert/40! text-alert!',
          warning: 'text-outflow!',
        },
      }}
      // Sonner colours its own shell from these variables. Setting them means a toast rendered
      // before the utility classes land is still the right colour rather than white-on-white.
      style={
        {
          '--normal-bg': 'var(--ink-700)',
          '--normal-border': 'var(--line-strong)',
          '--normal-text': 'var(--text)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

Toaster.displayName = 'Toaster';
