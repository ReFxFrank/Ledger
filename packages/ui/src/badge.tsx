'use client';

import * as React from 'react';
import { type VariantProps, cva } from 'class-variance-authority';
import { cn } from './lib/cn';

/**
 * A small labelled chip.
 *
 * The tone list is the semantic palette and nothing else. `outflow` for money leaving, `reclaim`
 * for money recovered, `alert` for a problem, `control` for something interactive or in flight,
 * `neutral` for everything that is merely true.
 */
const badge = cva(
  'inline-flex max-w-full items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[0.6875rem] font-medium leading-4',
  {
    variants: {
      tone: {
        neutral: 'border-line-strong bg-ink-600 text-text-2',
        outflow: 'border-outflow/30 bg-outflow-dim text-outflow',
        reclaim: 'border-reclaim/30 bg-reclaim-dim text-reclaim',
        alert: 'border-alert/30 bg-alert-dim text-alert',
        control: 'border-control/35 bg-control-dim text-control-2',
      },
      mono: {
        true: 'font-mono tabular-nums',
        false: '',
      },
    },
    defaultVariants: { tone: 'neutral', mono: false },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badge>['tone']>;

export interface BadgeProps
  extends React.ComponentPropsWithoutRef<'span'>,
    VariantProps<typeof badge> {}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, tone, mono, ...props },
  ref,
) {
  return <span ref={ref} className={cn(badge({ tone, mono }), className)} {...props} />;
});
