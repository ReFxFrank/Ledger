'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn, focusRing } from './lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn('fixed inset-0 z-50 bg-ink-900/70 backdrop-blur-[1px]', className)}
      {...props}
    />
  );
});

export interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Hide the corner close button when the flow must end in an explicit choice. */
  readonly showClose?: boolean;
}

/**
 * Modal content.
 *
 * No enter/exit animation on purpose: §6.5 allows hover lift and border brighten, and a dialog
 * that scales in delays the first keystroke of a form the user opened deliberately.
 *
 * `max-h` plus an inner scroll keeps a long cancellation playbook usable at 375px, where a
 * centred dialog otherwise runs off both ends of the screen.
 */
export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent({ className, children, showClose = true, ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col',
          'rounded-lg border border-line-strong bg-ink-800 shadow-overlay',
          className,
        )}
        {...props}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close
            className={cn(
              'absolute right-3 top-3 grid size-7 place-items-center rounded-md text-text-3',
              'transition-colors duration-[var(--duration-fast)] ease-standard hover:bg-ink-700 hover:text-text',
              focusRing,
            )}
          >
            <X className="size-4" aria-hidden />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

export const DialogHeader = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  function DialogHeader({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn('shrink-0 border-b border-line px-[var(--pad-panel)] py-[var(--gap-loose)] pr-12', className)}
        {...props}
      />
    );
  },
);

export const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-sm font-medium leading-tight text-text', className)}
      {...props}
    />
  );
});

export const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description ref={ref} className={cn('mt-1 text-xs text-text-2', className)} {...props} />
  );
});

export const DialogBody = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  function DialogBody({ className, ...props }, ref) {
    return <div ref={ref} className={cn('min-h-0 flex-1 overflow-y-auto p-[var(--pad-panel)]', className)} {...props} />;
  },
);

export const DialogFooter = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  function DialogFooter({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'flex shrink-0 flex-wrap items-center justify-end gap-[var(--gap-tight)] border-t border-line px-[var(--pad-panel)] py-[var(--gap-loose)]',
          className,
        )}
        {...props}
      />
    );
  },
);
