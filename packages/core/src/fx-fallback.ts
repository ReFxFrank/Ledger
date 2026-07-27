/**
 * Static fallback FX rates — the honest floor under the missing rate feed.
 *
 * There is still no daily rate job (that needs a rate *source* decision, and the TODO for it
 * lives in the dashboard router). Until it exists the choice is between three behaviours for a
 * subscription billed in a currency other than the display currency:
 *
 *  1. Convert at 1.0 and say nothing — a silent lie.
 *  2. Exclude it from the totals — honest, but it understates the user's real commitment,
 *     and for a product whose whole job is "what am I actually committed to", an understated
 *     total is the worse lie.
 *  3. Convert at a dated, clearly-labelled indicative rate — approximately right, and the UI
 *     says so and says *when* the rate is from.
 *
 * This module is option 3. The table below is a hand-maintained quarterly snapshot of the six
 * majors against USD, rounded to headline precision on purpose: four significant figures would
 * imply an accuracy the mechanism does not have. Being half a year stale is acceptable — major
 * pairs rarely move enough between quarters to change the *shape* of a commitment total, and
 * every figure derived from these rates is surfaced as approximate, never as fact.
 *
 * UPDATE CADENCE: refresh the snapshot each quarter (append a new entry, keep the old ones so
 * historical `asOf` dates keep resolving to the rates that were current then).
 */

import { type FxRate, type RateTable, fxRate, staticRateTable } from './fx';

export interface FallbackRateSnapshot {
  /** The date the snapshot was taken — what the UI shows as "indicative rate from …". */
  readonly asOf: string;
  readonly rates: readonly FxRate[];
}

/** Snapshot taken 2026-06-30 (end of Q2 2026). Mid-market, rounded to two significant figures of the quote. */
const Q2_2026: FallbackRateSnapshot = {
  asOf: '2026-06-30',
  rates: [
    fxRate('EUR', 'USD', '1.17', '2026-06-30'),
    fxRate('GBP', 'USD', '1.35', '2026-06-30'),
    fxRate('JPY', 'USD', '0.0065', '2026-06-30'),
    fxRate('CAD', 'USD', '0.72', '2026-06-30'),
    fxRate('AUD', 'USD', '0.66', '2026-06-30'),
    fxRate('CHF', 'USD', '1.25', '2026-06-30'),
  ],
};

/** Ascending by `asOf`. Append new quarters at the end; never edit an existing snapshot. */
const SNAPSHOTS: readonly FallbackRateSnapshot[] = [Q2_2026];

/**
 * The snapshot in force on a given date: the latest one taken on or before `asOf`.
 *
 * A date before the first snapshot still gets the first snapshot rather than nothing — an
 * indicative rate labelled with its date is more honest than silently excluding the row, which
 * is the whole reason this module exists.
 */
export function fallbackSnapshotFor(asOf: string): FallbackRateSnapshot {
  let chosen: FallbackRateSnapshot = Q2_2026;
  for (const snapshot of SNAPSHOTS) {
    // Plain-date strings are lexicographically ordered, so string comparison is date comparison.
    if (snapshot.asOf <= asOf) chosen = snapshot;
  }
  return chosen;
}

/**
 * A `RateTable` over the fallback snapshot for `asOf`.
 *
 * Majors against USD only, direct or inverted — deliberately no triangulation through USD for
 * cross pairs (EUR display currency with a GBP subscription). A cross rate derived from two
 * rounded indicative quotes compounds both roundings, and those rows land in `unconvertible`
 * instead, which the UI already explains.
 */
export function staticFallbackRates(asOf: string): RateTable {
  return staticRateTable(fallbackSnapshotFor(asOf).rates);
}
