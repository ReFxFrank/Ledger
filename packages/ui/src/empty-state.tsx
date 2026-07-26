'use client';

import * as React from 'react';
import { cn } from './lib/cn';

export interface EmptyStateProps extends React.ComponentPropsWithoutRef<'div'> {
  /** A lucide icon element, sized by this component. Decorative — the line carries the meaning. */
  readonly icon?: React.ReactNode;
  /** The actions themselves, not a link to somewhere the user can find them. */
  readonly actions?: React.ReactNode;
}

/**
 * An empty state is an invitation, never an apology.
 *
 * "Nothing to show here yet" tells the user what they can already see. So the line is a verb —
 * "Add your first subscription" — and the button that does it sits on the same row, because a
 * user who has to go and find the action is a user who leaves.
 */
export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { className, icon, actions, children, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'flex flex-col items-center justify-center gap-[var(--gap-loose)] px-[var(--pad-panel)] py-10 text-center',
        // Stacks under 640px so the line and the button never fight for the same 375px row.
        'sm:flex-row sm:text-left',
        className,
      )}
      {...props}
    >
      {icon ? (
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-md border border-line bg-ink-700 text-text-3 [&_svg]:size-4"
        >
          {icon}
        </span>
      ) : null}
      <p className="max-w-prose text-sm text-text-2">{children}</p>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-[var(--gap-tight)]">{actions}</div>
      ) : null}
    </div>
  );
});
