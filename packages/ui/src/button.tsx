'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { type VariantProps, cva } from 'class-variance-authority';
import { cn, focusRing } from './lib/cn';
import { Spinner } from './spinner';

/**
 * Button.
 *
 * Colour comes from the semantic tokens, which constrains the variants more than a generic kit
 * would: there is no "success" button, because `--reclaim` belongs to the savings counter alone.
 * `danger` sits dim until it is hovered — a destructive control should look available, not armed.
 */
const button = cva(
  cn(
    'relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 rounded-md border font-medium leading-none',
    'transition-[background-color,border-color,color,transform] duration-[var(--duration-fast)] ease-standard',
    'disabled:pointer-events-none disabled:opacity-45',
    focusRing,
  ),
  {
    variants: {
      variant: {
        // Text is `--ink-900`, not white: white on `--control` is 3.9:1, which misses AA.
        primary: 'border-control bg-control text-ink-900 hover:border-control-2 hover:bg-control-2',
        secondary: 'border-line-strong bg-ink-700 text-text hover:border-line-hot hover:bg-ink-600',
        ghost: 'border-transparent bg-transparent text-text-2 hover:border-line hover:bg-ink-700 hover:text-text',
        danger: 'border-alert/35 bg-alert-dim text-alert hover:border-alert hover:bg-alert hover:text-ink-900',
      },
      size: {
        sm: 'h-7 text-xs',
        md: 'h-9 text-[0.8125rem]',
      },
      iconOnly: {
        true: 'px-0',
        false: '',
      },
    },
    compoundVariants: [
      { size: 'sm', iconOnly: false, class: 'px-2.5' },
      { size: 'md', iconOnly: false, class: 'px-3.5' },
      { size: 'sm', iconOnly: true, class: 'w-7' },
      { size: 'md', iconOnly: true, class: 'w-9' },
    ],
    defaultVariants: { variant: 'secondary', size: 'md', iconOnly: false },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof button>['variant']>;

export interface ButtonProps
  extends React.ComponentPropsWithoutRef<'button'>,
    Omit<VariantProps<typeof button>, 'iconOnly'> {
  /** Square padding for a lone icon. Supply an `aria-label` when you use it. */
  readonly iconOnly?: boolean;
  readonly loading?: boolean;
  /**
   * Render the child element instead of a `<button>` — for links that look like buttons.
   * `loading` is ignored in this mode: we cannot put a spinner inside an arbitrary child.
   */
  readonly asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, iconOnly = false, loading = false, asChild = false, disabled, children, ...props },
  ref,
) {
  const classes = cn(button({ variant, size, iconOnly }), className);

  if (asChild) {
    return (
      <Slot ref={ref} className={classes} {...props}>
        {children}
      </Slot>
    );
  }

  return (
    <button
      ref={ref}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {/*
        The label stays in the layout while it is invisible, so the button keeps its width and
        the row of controls next to it does not jump when a mutation starts.
      */}
      <span className={cn('inline-flex items-center gap-1.5', loading && 'invisible')}>{children}</span>
      {loading ? (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner size={size === 'sm' ? 'sm' : 'md'} />
        </span>
      ) : null}
    </button>
  );
});
