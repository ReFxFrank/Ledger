'use client';

import * as React from 'react';
import { SUBSCRIPTION_STATUS_LABELS, type SubscriptionStatus } from '@ledger/core';
import { cn } from './lib/cn';

/**
 * Status, coloured honestly.
 *
 * `active` is neutral. A subscription charging you the amount it agreed to charge you is not a
 * success and not a problem — it is the normal case, and painting the normal case green teaches
 * the user to ignore colour entirely. The only status that gets `--control` is `trialing`,
 * because a trial is a clock the user is expected to act on; the finished states fade to
 * `--text-3` because they no longer cost anything.
 *
 * `--alert` is never reachable from a status alone. It is opt-in via `problem`, which the caller
 * sets when it knows the actual fact — the trial ends on Friday, the cancel-by date has passed.
 */
const TONE_CLASSES = {
  neutral: 'border-line-strong bg-ink-600 text-text',
  neutralDim: 'border-line bg-ink-700 text-text-2',
  muted: 'border-line bg-transparent text-text-3',
  control: 'border-control/35 bg-control-dim text-control-2',
  alert: 'border-alert/35 bg-alert-dim text-alert',
} as const;

type StatusTone = keyof typeof TONE_CLASSES;

const STATUS_TONES: Readonly<Record<SubscriptionStatus, StatusTone>> = {
  trialing: 'control',
  active: 'neutral',
  paused: 'muted',
  cancel_scheduled: 'neutralDim',
  canceled: 'muted',
  lapsed: 'muted',
  unknown: 'neutralDim',
};

export interface StatusPillProps extends React.ComponentPropsWithoutRef<'span'> {
  readonly status: SubscriptionStatus;
  /**
   * Something about *this* subscription needs attention right now. Overrides the tone to
   * `--alert` and keeps the status label, so the pill still says what the state is.
   */
  readonly problem?: boolean;
  /** A dot before the label. On by default: it survives a screenshot printed in greyscale. */
  readonly dot?: boolean;
}

export const StatusPill = React.forwardRef<HTMLSpanElement, StatusPillProps>(function StatusPill(
  { className, status, problem = false, dot = true, ...props },
  ref,
) {
  const tone = problem ? 'alert' : STATUS_TONES[status];
  const label = SUBSCRIPTION_STATUS_LABELS[status];

  return (
    <span
      ref={ref}
      data-status={status}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[0.6875rem] font-medium leading-4',
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    >
      {dot ? <span aria-hidden className="size-1.5 rounded-sm bg-current opacity-80" /> : null}
      {label}
    </span>
  );
});
