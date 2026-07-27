'use client';

import * as React from 'react';
import { Search } from 'lucide-react';
import { Command as CommandPrimitive, useCommandState } from 'cmdk';
import { cn } from './lib/cn';

/**
 * The command menu, as parts.
 *
 * `cmdk` is wrapped rather than used raw for the usual reason — a palette built in the app would
 * hardcode six colours — but also for an accessibility one worth stating: the primitive already
 * wires `role="combobox"` on the input, `role="listbox"` on the list, `role="option"` on every
 * row, and keeps `aria-activedescendant` pointed at the highlighted row as the arrows move. That
 * is the hard half of a palette, and re-implementing it by hand is how it ends up half-wired.
 *
 * There is deliberately no dialog here. `Command` is a plain element; the app wraps it in the
 * `Dialog` from this same package, so the palette gets the focus trap, the Escape handling and
 * the focus restoration every other overlay in the product already has, rather than a second
 * implementation of all three that has to be kept in step with the first.
 *
 * Filtering is the caller's decision. `Command` filters and sorts by default, which is right for
 * a fixed list of commands and wrong for rows that came back from a server query already ranked
 * — pass `shouldFilter={false}` and render what you want shown.
 */

export const Command = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(function Command({ className, ...props }, ref) {
  return (
    <CommandPrimitive
      ref={ref}
      className={cn('flex min-h-0 w-full flex-col overflow-hidden', className)}
      {...props}
    />
  );
});

/**
 * The search field.
 *
 * Borderless and full-bleed: inside a palette the whole surface *is* the field, and a second
 * rounded rectangle drawn one pixel inside the dialog's own is a border for the sake of a border.
 */
export const CommandInput = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(function CommandInput({ className, ...props }, ref) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-[var(--pad-panel)]">
      <Search aria-hidden className="size-4 shrink-0 text-text-3" strokeWidth={1.75} />
      <CommandPrimitive.Input
        ref={ref}
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-3',
          className,
        )}
        {...props}
      />
    </div>
  );
});

export const CommandList = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(function CommandList({ className, ...props }, ref) {
  return (
    <CommandPrimitive.List
      ref={ref}
      className={cn(
        // Capped in dvh as well as rem so the list still ends above the fold on a phone in
        // landscape, where 24rem is taller than the viewport.
        'max-h-[min(24rem,55dvh)] min-h-0 overflow-y-auto overscroll-contain p-1.5',
        className,
      )}
      {...props}
    />
  );
});

export const CommandEmpty = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(function CommandEmpty({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Empty
      ref={ref}
      className={cn('px-[var(--pad-panel)] py-7 text-center text-xs text-text-2', className)}
      {...props}
    />
  );
});

/**
 * A titled run of rows.
 *
 * The heading element is rendered by the primitive, so the eyebrow treatment (11px, uppercase,
 * +0.08em, `--text-3`) is reached through its attribute rather than applied to a class of ours.
 */
export const CommandGroup = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(function CommandGroup({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Group
      ref={ref}
      className={cn(
        '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5',
        '[&_[cmdk-group-heading]]:text-[0.6875rem] [&_[cmdk-group-heading]]:font-medium',
        '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em]',
        '[&_[cmdk-group-heading]]:leading-[1.2] [&_[cmdk-group-heading]]:text-text-3',
        className,
      )}
      {...props}
    />
  );
});

export const CommandSeparator = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(function CommandSeparator({ className, ...props }, ref) {
  return <CommandPrimitive.Separator ref={ref} className={cn('-mx-1.5 my-1 h-px bg-line', className)} {...props} />;
});

/**
 * One row.
 *
 * The highlight is a surface step plus a brightened border, never a colour change: the row under
 * the cursor and the row under the arrow keys are the same state, and tinting it would spend a
 * semantic colour on "this is where you are".
 */
export const CommandItem = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(function CommandItem({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Item
      ref={ref}
      className={cn(
        'flex cursor-default select-none items-center gap-2.5 rounded-md border border-transparent',
        'px-2 py-1.5 text-[0.8125rem] leading-5 text-text-2 outline-none',
        'transition-[background-color,border-color,color] duration-[var(--duration-fast)] ease-standard',
        'data-[selected=true]:border-line-hot data-[selected=true]:bg-ink-600 data-[selected=true]:text-text',
        'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        className,
      )}
      {...props}
    />
  );
});

/** The trailing hint on a row: a key, a count, a cadence. Never the row's own label. */
export const CommandMeta = React.forwardRef<HTMLSpanElement, React.ComponentPropsWithoutRef<'span'>>(
  function CommandMeta({ className, ...props }, ref) {
    return (
      <span
        ref={ref}
        className={cn('ml-auto shrink-0 font-mono text-[0.6875rem] tabular-nums text-text-3', className)}
        {...props}
      />
    );
  },
);

export { useCommandState };
