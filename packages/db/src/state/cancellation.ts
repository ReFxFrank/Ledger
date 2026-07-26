/**
 * The cancellation request state machine.
 *
 * Same reasoning as the subscription machine, with a sharper edge: this workflow is the one the
 * user is trusting. `confirmed` and `verified` are deliberately different states —
 *
 *   confirmed = the provider said it is cancelled
 *   verified  = the charge we expected did not arrive
 *
 * — because the first is a claim and the second is a fact, and conflating them is exactly how a
 * subscription tracker ends up telling someone they are safe while a payment is in flight.
 */

import { type CancellationStatus, InvalidStateTransitionError } from '@ledger/core';

export type CancellationTrigger =
  | 'user_started'
  | 'user_progressed'
  | 'user_submitted'
  | 'user_recorded_confirmation'
  | 'user_abandoned'
  | 'user_reopened'
  | 'user_accepted_retention_offer'
  | 'verification_passed'
  | 'verification_failed'
  | 'deadline_passed';

export interface CancellationTransition {
  readonly from: CancellationStatus;
  readonly to: CancellationStatus;
  readonly trigger: CancellationTrigger;
  readonly describe: string;
}

export const CANCELLATION_TRANSITIONS: readonly CancellationTransition[] = [
  { from: 'draft', to: 'in_progress', trigger: 'user_started', describe: 'Cancellation started' },
  { from: 'draft', to: 'abandoned', trigger: 'user_abandoned', describe: 'Abandoned before starting' },

  { from: 'in_progress', to: 'in_progress', trigger: 'user_progressed', describe: 'Step completed' },
  {
    from: 'in_progress',
    to: 'awaiting_confirmation',
    trigger: 'user_submitted',
    describe: 'Request sent — waiting for the provider',
  },
  {
    from: 'in_progress',
    to: 'confirmed',
    trigger: 'user_recorded_confirmation',
    describe: 'Confirmation received',
  },
  {
    from: 'in_progress',
    to: 'abandoned',
    trigger: 'user_accepted_retention_offer',
    describe: 'Stayed for a retention offer',
  },
  { from: 'in_progress', to: 'abandoned', trigger: 'user_abandoned', describe: 'Abandoned' },

  {
    from: 'awaiting_confirmation',
    to: 'confirmed',
    trigger: 'user_recorded_confirmation',
    describe: 'Confirmation received',
  },
  {
    from: 'awaiting_confirmation',
    to: 'awaiting_confirmation',
    trigger: 'deadline_passed',
    describe: 'Still unconfirmed past the deadline',
  },
  {
    from: 'awaiting_confirmation',
    to: 'in_progress',
    trigger: 'user_reopened',
    describe: 'Reopened to try again',
  },
  { from: 'awaiting_confirmation', to: 'abandoned', trigger: 'user_abandoned', describe: 'Abandoned' },

  // The two outcomes that matter. Brief §3.1 step 7.
  {
    from: 'confirmed',
    to: 'verified',
    trigger: 'verification_passed',
    describe: 'Verified — the expected charge never arrived',
  },
  {
    from: 'confirmed',
    to: 'failed',
    trigger: 'verification_failed',
    describe: 'Charged again despite the confirmation',
  },
  {
    from: 'awaiting_confirmation',
    to: 'failed',
    trigger: 'verification_failed',
    describe: 'Charged again while still unconfirmed',
  },

  { from: 'failed', to: 'in_progress', trigger: 'user_reopened', describe: 'Reopened after a failed cancellation' },
  { from: 'abandoned', to: 'in_progress', trigger: 'user_reopened', describe: 'Reopened' },
];

const INDEX: ReadonlyMap<string, CancellationTransition> = new Map(
  CANCELLATION_TRANSITIONS.map((t) => [`${t.from}|${t.trigger}|${t.to}`, t]),
);

export function canTransitionCancellation(
  from: CancellationStatus,
  trigger: CancellationTrigger,
  to: CancellationStatus,
): boolean {
  return INDEX.has(`${from}|${trigger}|${to}`);
}

export function transitionCancellation(
  from: CancellationStatus,
  trigger: CancellationTrigger,
  to: CancellationStatus,
): CancellationTransition {
  const found = INDEX.get(`${from}|${trigger}|${to}`);
  if (found === undefined) {
    throw new InvalidStateTransitionError('CancellationRequest', `${from} --${trigger}-->`, to);
  }
  return found;
}

export function resolveCancellationTransition(
  from: CancellationStatus,
  trigger: CancellationTrigger,
): CancellationTransition | null {
  const candidates = CANCELLATION_TRANSITIONS.filter((t) => t.from === from && t.trigger === trigger);
  const only = candidates[0];
  if (only === undefined || candidates.length > 1) return null;
  return only;
}

/** Statuses that still need something to happen. The board's "active" columns, and what gets nagged. */
export const OPEN_CANCELLATION_STATUSES: readonly CancellationStatus[] = [
  'draft',
  'in_progress',
  'awaiting_confirmation',
];

export function isOpen(status: CancellationStatus): boolean {
  return OPEN_CANCELLATION_STATUSES.includes(status);
}

/** Statuses that should be watched against the bank feed. */
export function awaitsVerification(status: CancellationStatus): boolean {
  return status === 'confirmed' || status === 'awaiting_confirmation';
}
