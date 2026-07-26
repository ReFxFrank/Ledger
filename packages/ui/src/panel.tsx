'use client';

import * as React from 'react';
import { cn } from './lib/cn';

/**
 * The workhorse container: one bordered surface at `--ink-800`, sitting on the `--ink-900` page.
 *
 * Padding lives on `PanelHeader` and `PanelBody` rather than on `Panel`, so a panel can hold a
 * full-bleed table — the one layout where a wrapper's own padding is impossible to undo.
 */
export const Panel = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'section'>>(
  function Panel({ className, ...props }, ref) {
    return (
      <section
        ref={ref}
        className={cn('rounded-lg border border-line bg-ink-800 shadow-card', className)}
        {...props}
      />
    );
  },
);

export interface PanelHeaderProps extends React.ComponentPropsWithoutRef<'header'> {
  /** The 11px uppercase label. Sentence content, rendered uppercase by CSS. */
  readonly eyebrow: string;
  /** Buttons, filters, a count — anything that acts on what the panel contains. */
  readonly actions?: React.ReactNode;
}

export const PanelHeader = React.forwardRef<HTMLElement, PanelHeaderProps>(function PanelHeader(
  { className, eyebrow, actions, children, ...props },
  ref,
) {
  return (
    <header
      ref={ref}
      className={cn(
        // Wraps rather than squashing: at 375px the actions drop under the title instead of
        // collapsing the eyebrow to two characters and an ellipsis.
        'flex flex-wrap items-start justify-between gap-[var(--gap)] border-b border-line px-[var(--pad-panel)] py-[var(--gap-loose)]',
        className,
      )}
      {...props}
    >
      <div className="min-w-0">
        <p className="eyebrow">{eyebrow}</p>
        {children ? <div className="mt-1.5 text-sm text-text">{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-[var(--gap-tight)]">{actions}</div> : null}
    </header>
  );
});

export const PanelBody = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  function PanelBody({ className, ...props }, ref) {
    return <div ref={ref} className={cn('p-[var(--pad-panel)]', className)} {...props} />;
  },
);
