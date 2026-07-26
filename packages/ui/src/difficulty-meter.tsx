'use client';

import * as React from 'react';
import { type CancellationDifficulty, DIFFICULTY_LABELS } from '@ledger/core';
import { cn } from './lib/cn';

/**
 * How hard this provider makes it to leave (brief §3.2).
 *
 * Each filled segment takes its own `--difficulty-N`, so the bar ramps green → amber → red as it
 * fills instead of restating one colour five times. The scale deliberately ends at a dulled red
 * rather than `--alert`: difficulty 5 is honest information about a provider, not an error the
 * user has to fix, and it must not compete with a real alert on the same screen.
 *
 * The label is `DIFFICULTY_LABELS` verbatim. It is never softened — "requires a phone call" is
 * the whole reason the meter exists.
 */
const DIFFICULTY_VARS: Readonly<Record<CancellationDifficulty, string>> = {
  1: 'var(--difficulty-1)',
  2: 'var(--difficulty-2)',
  3: 'var(--difficulty-3)',
  4: 'var(--difficulty-4)',
  5: 'var(--difficulty-5)',
};

const LEVELS: readonly CancellationDifficulty[] = [1, 2, 3, 4, 5];

export interface DifficultyMeterProps extends Omit<React.ComponentPropsWithoutRef<'div'>, 'children'> {
  readonly level: CancellationDifficulty;
  /** Show the written label beside the bar. Off in a dense table cell, on everywhere else. */
  readonly showLabel?: boolean;
  readonly size?: 'sm' | 'md';
}

export const DifficultyMeter = React.forwardRef<HTMLDivElement, DifficultyMeterProps>(
  function DifficultyMeter({ className, level, showLabel = true, size = 'md', ...props }, ref) {
    const label = DIFFICULTY_LABELS[level];

    return (
      <div
        ref={ref}
        // One role="img" for the whole widget: five separately-labelled bars would make a screen
        // reader read the shape instead of the fact.
        role="img"
        aria-label={`Cancellation difficulty ${String(level)} of 5 — ${label}`}
        className={cn('flex items-center gap-[var(--gap-tight)]', className)}
        {...props}
      >
        <span aria-hidden className="flex items-center gap-0.5">
          {LEVELS.map((segment) => (
            <span
              key={segment}
              className={cn('rounded-sm', size === 'sm' ? 'h-1 w-3' : 'h-1.5 w-4')}
              style={
                segment <= level
                  ? { backgroundColor: DIFFICULTY_VARS[segment] }
                  : { backgroundColor: 'var(--ink-600)' }
              }
            />
          ))}
        </span>
        {showLabel ? <span className="text-xs leading-tight text-text-2">{label}</span> : null}
      </div>
    );
  },
);
