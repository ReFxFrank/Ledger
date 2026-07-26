/**
 * The subscription status state machine.
 *
 * Brief §5: "Transitions are enforced in a state machine — not scattered `update` calls."
 *
 * The reason this is a machine rather than a convention: statuses here are written by three
 * different actors — the user, the detection engine, and the verification job — and they race.
 * A verification job concluding "no charge appeared, mark it canceled" must not silently
 * overwrite a user who reactivated in the meantime. Every transition is declared, guarded, and
 * refused loudly if it makes no sense.
 */

import { InvalidStateTransitionError, type SubscriptionStatus } from '@ledger/core';

export type TransitionTrigger =
  | 'user_created'
  | 'user_edited'
  | 'user_paused'
  | 'user_resumed'
  | 'user_archived'
  | 'user_reactivated'
  | 'detection_confirmed'
  | 'trial_converted'
  | 'trial_cancelled_before_conversion'
  | 'cancellation_started'
  | 'cancellation_abandoned'
  | 'cancellation_confirmed'
  | 'cancellation_verified'
  | 'charge_after_cancellation'
  | 'charges_stopped'
  | 'charges_long_stopped'
  | 'charge_observed'
  | 'import_unknown';

export interface Transition {
  readonly from: SubscriptionStatus;
  readonly to: SubscriptionStatus;
  readonly trigger: TransitionTrigger;
  /** Shown in the audit log — a person reads this. */
  readonly describe: string;
}

/**
 * The complete transition table.
 *
 * Deliberately explicit rather than pattern-matched: reading this list is how you answer
 * "can a cancelled subscription come back?" (yes — user_reactivated, because providers reinstate
 * and users change their minds) and "can a lapsed one go straight to trialing?" (no).
 */
export const TRANSITIONS: readonly Transition[] = [
  // ── creation ────────────────────────────────────────────────────────────────────────
  { from: 'unknown', to: 'active', trigger: 'user_created', describe: 'Added manually' },
  { from: 'unknown', to: 'trialing', trigger: 'user_created', describe: 'Added manually as a trial' },
  { from: 'unknown', to: 'active', trigger: 'detection_confirmed', describe: 'Confirmed from the review queue' },
  { from: 'unknown', to: 'trialing', trigger: 'detection_confirmed', describe: 'Confirmed as a trial' },
  { from: 'unknown', to: 'unknown', trigger: 'import_unknown', describe: 'Imported without a status' },

  // ── trial ───────────────────────────────────────────────────────────────────────────
  { from: 'trialing', to: 'active', trigger: 'trial_converted', describe: 'Trial converted to a paid plan' },
  {
    from: 'trialing',
    to: 'canceled',
    trigger: 'trial_cancelled_before_conversion',
    describe: 'Cancelled before the trial converted',
  },
  { from: 'trialing', to: 'cancel_scheduled', trigger: 'cancellation_started', describe: 'Cancellation started' },
  { from: 'trialing', to: 'paused', trigger: 'user_paused', describe: 'Paused by you' },
  { from: 'trialing', to: 'active', trigger: 'user_edited', describe: 'Marked as active' },

  // ── active ──────────────────────────────────────────────────────────────────────────
  { from: 'active', to: 'cancel_scheduled', trigger: 'cancellation_started', describe: 'Cancellation started' },
  { from: 'active', to: 'paused', trigger: 'user_paused', describe: 'Paused by you' },
  { from: 'active', to: 'paused', trigger: 'charges_stopped', describe: 'Charges stopped unexpectedly' },
  { from: 'active', to: 'trialing', trigger: 'user_edited', describe: 'Marked as a trial' },
  { from: 'active', to: 'canceled', trigger: 'user_edited', describe: 'Marked as cancelled' },
  { from: 'active', to: 'active', trigger: 'charge_observed', describe: 'Charged as expected' },
  { from: 'active', to: 'active', trigger: 'user_edited', describe: 'Details updated' },

  // ── paused / lapsed (brief §4.4: charges stop but nobody cancelled) ──────────────────
  { from: 'paused', to: 'active', trigger: 'user_resumed', describe: 'Resumed' },
  { from: 'paused', to: 'active', trigger: 'charge_observed', describe: 'Charged again — still active' },
  { from: 'paused', to: 'lapsed', trigger: 'charges_long_stopped', describe: 'No charge for two periods' },
  { from: 'paused', to: 'cancel_scheduled', trigger: 'cancellation_started', describe: 'Cancellation started' },
  { from: 'paused', to: 'canceled', trigger: 'user_edited', describe: 'Marked as cancelled' },

  { from: 'lapsed', to: 'active', trigger: 'charge_observed', describe: 'Charged again — reactivated' },
  { from: 'lapsed', to: 'active', trigger: 'user_reactivated', describe: 'Reactivated by you' },
  { from: 'lapsed', to: 'canceled', trigger: 'user_edited', describe: 'Marked as cancelled' },

  // ── cancelling ──────────────────────────────────────────────────────────────────────
  {
    from: 'cancel_scheduled',
    to: 'canceled',
    trigger: 'cancellation_confirmed',
    describe: 'Provider confirmed the cancellation',
  },
  {
    from: 'cancel_scheduled',
    to: 'canceled',
    trigger: 'cancellation_verified',
    describe: 'Verified — the expected charge never arrived',
  },
  {
    from: 'cancel_scheduled',
    to: 'active',
    trigger: 'cancellation_abandoned',
    describe: 'Cancellation abandoned',
  },
  {
    from: 'cancel_scheduled',
    to: 'active',
    trigger: 'charge_after_cancellation',
    describe: 'Charged again despite the cancellation',
  },
  { from: 'cancel_scheduled', to: 'cancel_scheduled', trigger: 'user_edited', describe: 'Details updated' },

  // ── cancelled ───────────────────────────────────────────────────────────────────────
  // A charge after `canceled` is the loud case: the subscription is demonstrably still live.
  {
    from: 'canceled',
    to: 'active',
    trigger: 'charge_after_cancellation',
    describe: 'Charged after cancelling — still active',
  },
  { from: 'canceled', to: 'active', trigger: 'user_reactivated', describe: 'Resubscribed' },
  { from: 'canceled', to: 'trialing', trigger: 'user_reactivated', describe: 'Resubscribed on a trial' },

  // ── unknown is a valid resting state for imports we could not classify ───────────────
  { from: 'unknown', to: 'active', trigger: 'charge_observed', describe: 'Charged — treated as active' },
  { from: 'unknown', to: 'canceled', trigger: 'user_edited', describe: 'Marked as cancelled' },
  { from: 'unknown', to: 'paused', trigger: 'user_paused', describe: 'Paused by you' },
];

const INDEX: ReadonlyMap<string, Transition> = new Map(
  TRANSITIONS.map((t) => [`${t.from}|${t.trigger}|${t.to}`, t]),
);

function key(from: SubscriptionStatus, trigger: TransitionTrigger, to: SubscriptionStatus): string {
  return `${from}|${trigger}|${to}`;
}

export function canTransition(
  from: SubscriptionStatus,
  trigger: TransitionTrigger,
  to: SubscriptionStatus,
): boolean {
  return INDEX.has(key(from, trigger, to));
}

/** Every status reachable from `from` via `trigger`. Usually zero or one. */
export function allowedTargets(
  from: SubscriptionStatus,
  trigger: TransitionTrigger,
): SubscriptionStatus[] {
  return TRANSITIONS.filter((t) => t.from === from && t.trigger === trigger).map((t) => t.to);
}

/** Everything the user is allowed to do to a subscription in this status. Drives the UI menu. */
export function availableUserTransitions(from: SubscriptionStatus): Transition[] {
  return TRANSITIONS.filter((t) => t.from === from && t.trigger.startsWith('user_'));
}

/**
 * Applies a transition, or throws.
 *
 * Callers pass the trigger, not just the target status, so the audit log records *why* something
 * changed. "active → canceled" is not information; "active → canceled because the verification
 * job saw no charge in the 12 days after the expected renewal" is.
 */
export function transition(
  from: SubscriptionStatus,
  trigger: TransitionTrigger,
  to: SubscriptionStatus,
): Transition {
  const found = INDEX.get(key(from, trigger, to));
  if (found === undefined) {
    throw new InvalidStateTransitionError('Subscription', `${from} --${trigger}-->`, to);
  }
  return found;
}

/**
 * Resolves the target when a trigger has exactly one outcome from a given status.
 *
 * Jobs use this: the verification worker knows it wants `cancellation_verified`, not what status
 * that implies. Returns null when the trigger does not apply, which lets a job skip a row rather
 * than fail a batch.
 */
export function resolveTransition(
  from: SubscriptionStatus,
  trigger: TransitionTrigger,
): Transition | null {
  const candidates = TRANSITIONS.filter((t) => t.from === from && t.trigger === trigger);
  const only = candidates[0];
  if (only === undefined || candidates.length > 1) return null;
  return only;
}

/** Statuses a subscription can never leave without user action. Used to skip idle rows in jobs. */
export function isTerminalForAutomation(status: SubscriptionStatus): boolean {
  return TRANSITIONS.every((t) => t.from !== status || t.trigger.startsWith('user_'));
}
