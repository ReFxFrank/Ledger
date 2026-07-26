/**
 * Portfolio aggregation.
 *
 * Brief Phase 8: "all figures reconcile exactly with the subscriptions table". The way to make
 * that true is not to write a reconciliation test over two implementations — it is to have one
 * implementation. The dashboard totals, the analytics page, and the cancel simulator all call
 * into here, so reconciliation is structural and the test only has to prove the wiring.
 *
 * Pure: takes rows in, returns numbers out. No database, no clock, no locale.
 */

import type { CurrencyCode } from './currency';
import { type Money, add, money, subtract, zero } from './money';
import { type RecurrenceInterval } from './interval';
import { annualEquivalent, monthlyEquivalent } from './commitment';
import { type RateTable, convert } from './fx';
import type { Category, SubscriptionStatus } from './domain';
import { isCommitted } from './domain';

/** The minimum a row needs to expose to be counted. Deliberately narrower than the DB row. */
export interface CommitmentInput {
  readonly id: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly interval: RecurrenceInterval;
  readonly status: SubscriptionStatus;
  readonly category: Category;
  /** The user's own slice when the subscription is split. Defaults to the full amount. */
  readonly selfShareMinor?: number;
}

export interface CommitmentTotals {
  readonly monthly: Money;
  readonly annual: Money;
  /** What the user personally pays, after shares are deducted. */
  readonly monthlySelf: Money;
  readonly annualSelf: Money;
  readonly count: number;
  /** Rows that could not be converted into the display currency, so nothing is silently dropped. */
  readonly unconvertible: readonly string[];
}

export interface AggregateOptions {
  readonly displayCurrency: string | CurrencyCode;
  readonly rates: RateTable;
  readonly asOf: string;
  /** Defaults to the statuses that still cost money: trialing, active, cancel_scheduled. */
  readonly includeStatus?: (status: SubscriptionStatus) => boolean;
}

function convertOrNull(amount: Money, options: AggregateOptions): Money | null {
  const target = options.displayCurrency as CurrencyCode;
  if (amount.currency === target) return amount;
  const rate = options.rates.find(amount.currency, target, options.asOf);
  return rate === null ? null : convert(amount, rate);
}

/**
 * Totals across a set of subscriptions.
 *
 * Each row is annualized *in its own currency first*, then converted — not the other way round.
 * Converting first and annualizing second compounds the FX rounding error by the number of
 * periods in a year, which is how a weekly subscription ends up a few units out.
 */
export function aggregateCommitments(
  rows: readonly CommitmentInput[],
  options: AggregateOptions,
): CommitmentTotals {
  const target = options.displayCurrency;
  const include = options.includeStatus ?? isCommitted;

  let monthly = zero(target);
  let annual = zero(target);
  let monthlySelf = zero(target);
  let annualSelf = zero(target);
  let count = 0;
  const unconvertible: string[] = [];

  for (const row of rows) {
    if (!include(row.status)) continue;

    const charge = money(row.amountMinor, row.currency);
    const selfCharge = money(row.selfShareMinor ?? row.amountMinor, row.currency);

    const rowMonthly = convertOrNull(monthlyEquivalent(charge, row.interval), options);
    const rowAnnual = convertOrNull(annualEquivalent(charge, row.interval), options);
    const rowMonthlySelf = convertOrNull(monthlyEquivalent(selfCharge, row.interval), options);
    const rowAnnualSelf = convertOrNull(annualEquivalent(selfCharge, row.interval), options);

    if (
      rowMonthly === null ||
      rowAnnual === null ||
      rowMonthlySelf === null ||
      rowAnnualSelf === null
    ) {
      unconvertible.push(row.id);
      continue;
    }

    monthly = add(monthly, rowMonthly);
    annual = add(annual, rowAnnual);
    monthlySelf = add(monthlySelf, rowMonthlySelf);
    annualSelf = add(annualSelf, rowAnnualSelf);
    count += 1;
  }

  return { monthly, annual, monthlySelf, annualSelf, count, unconvertible };
}

export interface CategoryTotal {
  readonly category: Category;
  readonly monthly: Money;
  readonly annual: Money;
  readonly count: number;
}

export function aggregateByCategory(
  rows: readonly CommitmentInput[],
  options: AggregateOptions,
): CategoryTotal[] {
  const buckets = new Map<Category, CommitmentInput[]>();
  for (const row of rows) {
    const bucket = buckets.get(row.category);
    if (bucket === undefined) buckets.set(row.category, [row]);
    else bucket.push(row);
  }

  return [...buckets.entries()]
    .map(([category, group]) => {
      const totals = aggregateCommitments(group, options);
      return { category, monthly: totals.monthly, annual: totals.annual, count: totals.count };
    })
    .sort((a, b) => b.annual.amountMinor - a.annual.amountMinor);
}

/**
 * The cancel simulator (brief §7, /analytics).
 *
 * Returns what the portfolio looks like before and after, and the difference. Computed by
 * running the same aggregation over both sets rather than by subtracting per-row figures, so a
 * currency that cannot be converted is excluded consistently from both sides.
 */
export interface SimulationResult {
  readonly before: CommitmentTotals;
  readonly after: CommitmentTotals;
  readonly reclaimedMonthly: Money;
  readonly reclaimedAnnual: Money;
}

export function simulateCancellations(
  rows: readonly CommitmentInput[],
  cancelIds: readonly string[],
  options: AggregateOptions,
): SimulationResult {
  const cancelling = new Set(cancelIds);
  const before = aggregateCommitments(rows, options);
  const after = aggregateCommitments(
    rows.filter((row) => !cancelling.has(row.id)),
    options,
  );

  return {
    before,
    after,
    reclaimedMonthly: subtract(before.monthly, after.monthly),
    reclaimedAnnual: subtract(before.annual, after.annual),
  };
}
