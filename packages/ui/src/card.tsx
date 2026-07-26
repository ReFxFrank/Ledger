'use client';

import * as React from 'react';
import { cn, focusRing, hoverLift } from './lib/cn';

export interface CardProps extends React.ComponentPropsWithoutRef<'div'> {
  /**
   * The card is a target — it lifts on hover and takes keyboard focus.
   *
   * Off by default: a card that reacts to the pointer but does nothing when clicked is a lie
   * the user only discovers by trying.
   */
  readonly interactive?: boolean;
}

/**
 * The raised surface inside a panel. `--ink-700`, 14px, small radius.
 *
 * Hover changes the border and the elevation, never the fill. Repainting a card's background on
 * hover in a dense grid makes the whole page flicker as the pointer crosses it.
 */
export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, interactive = false, tabIndex, ...props },
  ref,
) {
  // An interactive card must be reachable by keyboard; an inert one must not be a tab stop.
  const resolvedTabIndex = tabIndex ?? (interactive ? 0 : undefined);
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-md border border-line bg-ink-700 p-[var(--pad-card)] shadow-card',
        interactive && cn(hoverLift, focusRing, 'cursor-pointer hover:shadow-raised'),
        className,
      )}
      tabIndex={resolvedTabIndex}
      {...props}
    />
  );
});

export const CardTitle = React.forwardRef<HTMLParagraphElement, React.ComponentPropsWithoutRef<'p'>>(
  function CardTitle({ className, ...props }, ref) {
    return <p ref={ref} className={cn('text-sm font-medium leading-tight text-text', className)} {...props} />;
  },
);

export const CardMeta = React.forwardRef<HTMLParagraphElement, React.ComponentPropsWithoutRef<'p'>>(
  function CardMeta({ className, ...props }, ref) {
    return <p ref={ref} className={cn('text-xs leading-tight text-text-2', className)} {...props} />;
  },
);
