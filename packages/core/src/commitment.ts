/**
 * Turning "£8.99 every 4 weeks" into "what does this cost me a month".
 *
 * Every headline number on the dashboard comes from here, and every one of them is a place
 * where a plausible-looking shortcut produces a wrong answer:
 *
 *  - "4-weekly is basically monthly" — it is 13 charges a year, not 12. Over a year that is a
 *    whole extra charge the user was not shown.
 *  - "annual ÷ 12" — fine, but only if the division rounds once, at the end, in integer space.
 *
 * So the interval carries an exact rational (see interval.ts) and the money helpers apply it
 * with a single explicit rounding step.
 */

import { type Money, type RoundingMode, scale } from './money';
import { type RecurrenceInterval, occurrencesPerMonth, occurrencesPerYear } from './interval';

/**
 * What this subscription costs per month on average.
 *
 * Rounded half-even because these figures get summed across dozens of subscriptions; half-up
 * would bias every total upward by a fraction of a unit per row.
 */
export function monthlyEquivalent(
  amount: Money,
  value: RecurrenceInterval,
  mode: RoundingMode = 'half-even',
): Money {
  const { numerator, denominator } = occurrencesPerMonth(value);
  return scale(amount, numerator, denominator, mode);
}

/** What this subscription costs per year. */
export function annualEquivalent(
  amount: Money,
  value: RecurrenceInterval,
  mode: RoundingMode = 'half-even',
): Money {
  const { numerator, denominator } = occurrencesPerYear(value);
  return scale(amount, numerator, denominator, mode);
}

/**
 * Cost per use, given a usage count over a window.
 *
 * The number that makes someone cancel: "£17.99 a month, opened twice — that's £9 a session."
 * Zero uses returns null rather than infinity, and the UI says "never used" instead of showing
 * a division-by-zero artifact.
 */
export function costPerUse(spend: Money, uses: number): Money | null {
  if (!Number.isInteger(uses) || uses < 0) return null;
  if (uses === 0) return null;
  return scale(spend, 1, uses, 'half-up');
}

/**
 * The saving from cancelling, as both figures the UI shows side by side.
 * Used by the reclaimed-savings counter and the "what if I cancel these" simulator.
 */
export interface Reclaim {
  readonly monthly: Money;
  readonly annual: Money;
}

export function reclaimFrom(amount: Money, value: RecurrenceInterval): Reclaim {
  return {
    monthly: monthlyEquivalent(amount, value),
    annual: annualEquivalent(amount, value),
  };
}
