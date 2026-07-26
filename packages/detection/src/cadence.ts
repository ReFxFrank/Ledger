/**
 * Cadence inference (brief §4.3).
 *
 * Given the dates a merchant charged, work out the billing interval — or admit there isn't one.
 * This is the part of detection that is easy to write badly and hard to notice you have: a
 * cadence engine that is 95% right invents subscriptions that do not exist and misses the annual
 * ones that matter most.
 *
 * Three decisions carry the whole file.
 *
 * 1. **Project from an anchor, never from the previous gap.** A monthly subscription anchored on
 *    the 31st charges Feb 28 and then *Mar 31*; the day-gap sequence for that is 28, 31, 30, 31 —
 *    which looks like noise if you compare gaps to a fixed number, and reads as perfectly regular
 *    if you compare each date to `anchor + n months`. `@ledger/core`'s `occurrence()` already
 *    clamps month-ends, so calendar-monthly is expressed directly rather than approximated as 30
 *    days. Everything else here exists to serve that comparison.
 * 2. **Every charge date is tried as the anchor.** A series first seen on Feb 28 and continuing
 *    Mar 31 / Apr 30 / May 31 is a month-end subscription, but only the Mar 31 charge reveals
 *    that; anchoring on the earliest date would call it three days of jitter forever. So the
 *    anchor reported here is the charge the cadence projects most cleanly from, which is
 *    deliberately not always `firstSeen`.
 * 3. **A missed period is a gap, not an ending.** Cards decline, banks post late, and a single
 *    skipped cycle followed by a charge back on the anchor is still one subscription. Two in a
 *    row is not — at that point the run has ended and whatever follows is a new one.
 */

import {
  ANNUAL,
  BIWEEKLY,
  FOUR_WEEKLY,
  MONTHLY,
  QUARTERLY,
  SEMIANNUAL,
  WEEKLY,
  addDays,
  approximateDays,
  comparePlainDate,
  daysBetween,
  isAfter,
  nextOccurrenceAfter,
  occurrence,
  type PlainDate,
  type RecurrenceInterval,
} from '@ledger/core';

// ── the candidate intervals ────────────────────────────────────────────────────────────

export interface CadenceCandidate {
  readonly interval: RecurrenceInterval;
  /**
   * How far a charge may land from its projected date and still count.
   *
   * Scaled to the period, because the sources of jitter scale with it: a weekly charge that
   * slips three days has changed its billing day, an annual one that slips three days hit a
   * weekend. Brief §4.3 fixes ±2 weekly, ±3 monthly, ±5 quarterly, ±10 annual; six-monthly sits
   * between the last two and is interpolated rather than invented.
   */
  readonly toleranceDays: number;
}

/**
 * Ordered from shortest to longest, which is also the tie-break order.
 *
 * Note what is *not* here: a 30-day interval. Calendar-monthly is `MONTHLY`, and the only
 * fixed-length near-monthly cadence that genuinely exists is four-weekly (13 charges a year, not
 * 12) — which is why it is listed separately and why conflating the two costs a user one charge
 * a year in every projection.
 */
export const CADENCE_CANDIDATES: readonly CadenceCandidate[] = [
  { interval: WEEKLY, toleranceDays: 2 },
  { interval: BIWEEKLY, toleranceDays: 2 },
  { interval: FOUR_WEEKLY, toleranceDays: 2 },
  { interval: MONTHLY, toleranceDays: 3 },
  { interval: QUARTERLY, toleranceDays: 5 },
  { interval: SEMIANNUAL, toleranceDays: 7 },
  { interval: ANNUAL, toleranceDays: 10 },
];

/** One skipped cycle is a gap; a second consecutive one ends the run. */
const MAX_CONSECUTIVE_MISSES = 1;

// ── result ─────────────────────────────────────────────────────────────────────────────

export interface CadenceFit {
  readonly interval: RecurrenceInterval;
  /** The charge date the run projects from. Not necessarily the earliest — see the header. */
  readonly anchor: PlainDate;
  /** Day gaps between consecutive matched charges. `matchedIndices.length - 1` entries. */
  readonly gapDays: readonly number[];
  /** 0..1, where 1 is every charge exactly on its projected date. */
  readonly jitterScore: number;
  /** Cycles inside the run with no charge. Two in a row would have ended the run instead. */
  readonly missedPeriods: number;
  /**
   * Indices into the caller's array, ascending, of the charges that form the run.
   *
   * Charges outside it — a trial at a different phase, a second charge inside one cycle, the
   * tail of an older cadence — are the caller's problem, not silently absorbed here.
   */
  readonly matchedIndices: readonly number[];
}

export interface CadenceOptions {
  /**
   * Replaces the whole per-interval tolerance table.
   *
   * An escape hatch for callers with a known-sloppy feed, not the normal path: one number for
   * every interval is exactly the approximation this module exists to avoid.
   */
  readonly toleranceDays?: number | undefined;
}

// ── alignment ──────────────────────────────────────────────────────────────────────────

interface Alignment {
  /** Which cycle from the anchor this date is closest to. Negative when the date precedes it. */
  readonly index: number;
  readonly deviation: number;
}

/**
 * Which projected occurrence a date belongs to, and how far off it landed.
 *
 * The nominal period length only seeds the search; the answer always comes from `occurrence()`,
 * so a clamped month-end is measured against the date the card issuer would actually have used.
 */
function alignmentOf(anchor: PlainDate, interval: RecurrenceInterval, date: PlainDate): Alignment {
  const estimate = Math.round(daysBetween(anchor, date) / approximateDays(interval));
  let best: Alignment = { index: estimate, deviation: Number.POSITIVE_INFINITY };
  for (let index = estimate - 1; index <= estimate + 1; index += 1) {
    const deviation = Math.abs(daysBetween(occurrence(anchor, interval, index), date));
    if (deviation < best.deviation) best = { index, deviation };
  }
  return best;
}

interface Fit {
  readonly candidateIndex: number;
  readonly anchorIndex: number;
  readonly members: readonly number[];
  readonly missed: number;
  readonly meanDeviation: number;
  readonly jitterScore: number;
}

/**
 * Grows the run containing `anchorIndex` in both directions.
 *
 * Only the run *through the anchor* is considered, because every date is tried as an anchor in
 * turn — a run elsewhere in the series will be found with its own anchor, in phase, rather than
 * being scored against a phase it never belonged to.
 */
function fitFrom(
  dates: readonly PlainDate[],
  anchorIndex: number,
  candidateIndex: number,
  toleranceOverride: number | undefined,
): Fit | null {
  const candidate = CADENCE_CANDIDATES[candidateIndex];
  const anchor = dates[anchorIndex];
  if (candidate === undefined || anchor === undefined) return null;

  const tolerance = toleranceOverride ?? candidate.toleranceDays;
  const before: number[] = [];
  const after: number[] = [];
  let missed = 0;
  let deviationSum = 0;

  let cycle = 0;
  for (let i = anchorIndex + 1; i < dates.length; i += 1) {
    const date = dates[i];
    if (date === undefined) continue;
    const alignment = alignmentOf(anchor, candidate.interval, date);
    // Off-cadence charges are stepped over, not treated as the end of the run: a one-off
    // purchase from a merchant you also subscribe to must not truncate the subscription. What
    // ends a run is silence — two consecutive cycles with no charge — which the step check
    // below still catches, because skipping a date does not advance the cycle counter.
    if (alignment.deviation > tolerance) continue;
    const step = alignment.index - cycle;
    // Two charges inside one cycle: the extra is not part of the cadence, but it does not end
    // it either. A duplicate posting must not truncate an otherwise clean run.
    if (step <= 0) continue;
    if (step - 1 > MAX_CONSECUTIVE_MISSES) break;
    missed += step - 1;
    deviationSum += alignment.deviation;
    after.push(i);
    cycle = alignment.index;
  }

  cycle = 0;
  for (let i = anchorIndex - 1; i >= 0; i -= 1) {
    const date = dates[i];
    if (date === undefined) continue;
    const alignment = alignmentOf(anchor, candidate.interval, date);
    if (alignment.deviation > tolerance) continue;
    const step = cycle - alignment.index;
    if (step <= 0) continue;
    if (step - 1 > MAX_CONSECUTIVE_MISSES) break;
    missed += step - 1;
    deviationSum += alignment.deviation;
    before.push(i);
    cycle = alignment.index;
  }

  const members = [...before.reverse(), anchorIndex, ...after];
  if (members.length < 2) return null;

  // The anchor's own deviation is zero by construction, so averaging it in would flatter every
  // fit by the same factor and, worse, flatter short runs more than long ones.
  const meanDeviation = deviationSum / (members.length - 1);
  return {
    candidateIndex,
    anchorIndex,
    members,
    missed,
    meanDeviation,
    jitterScore: Math.max(0, Math.min(1, 1 - meanDeviation / tolerance)),
  };
}

/**
 * Which of two fits explains the series better.
 *
 * Coverage first: a cadence that accounts for eleven charges beats one that accounts for four,
 * whatever its jitter. Then missed periods, which is what stops a fortnightly series being read
 * as "weekly, with every other week skipped" — both fit perfectly, only one is true. Then raw
 * deviation in days, deliberately *not* normalised by tolerance: at a 30-day gap, monthly is one
 * day off and four-weekly is two, and the tighter absolute fit is the honest winner. The last two
 * keys only exist so the result cannot depend on iteration order.
 */
function better(a: Fit, b: Fit): number {
  return (
    b.members.length - a.members.length ||
    a.missed - b.missed ||
    a.meanDeviation - b.meanDeviation ||
    a.candidateIndex - b.candidateIndex ||
    a.anchorIndex - b.anchorIndex
  );
}

// ── public API ─────────────────────────────────────────────────────────────────────────

/**
 * Infers the billing interval from a set of charge dates, or returns null if there isn't one.
 *
 * Input need not be sorted; `matchedIndices` always refers to the caller's own ordering.
 * O(dates² × candidates), which for a 24-month window of weekly charges is a few tens of
 * thousands of integer comparisons — cheap enough to buy the exhaustive anchor search.
 */
export function inferCadence(
  dates: readonly PlainDate[],
  options: CadenceOptions = {},
): CadenceFit | null {
  if (dates.length < 2) return null;

  const order = dates.map((_, index) => index);
  order.sort((left, right) => {
    const a = dates[left];
    const b = dates[right];
    if (a === undefined || b === undefined) return left - right;
    return comparePlainDate(a, b) || left - right;
  });
  const sorted = order
    .map((index) => dates[index])
    .filter((date): date is PlainDate => date !== undefined);
  if (sorted.length < 2) return null;

  let best: Fit | null = null;
  for (let candidateIndex = 0; candidateIndex < CADENCE_CANDIDATES.length; candidateIndex += 1) {
    for (let anchorIndex = 0; anchorIndex < sorted.length; anchorIndex += 1) {
      const fit = fitFrom(sorted, anchorIndex, candidateIndex, options.toleranceDays);
      if (fit === null) continue;
      if (best === null || better(fit, best) < 0) best = fit;
    }
  }
  if (best === null) return null;

  const candidate = CADENCE_CANDIDATES[best.candidateIndex];
  const anchor = sorted[best.anchorIndex];
  if (candidate === undefined || anchor === undefined) return null;

  const gapDays: number[] = [];
  for (let i = 1; i < best.members.length; i += 1) {
    const from = sorted[best.members[i - 1] ?? -1];
    const to = sorted[best.members[i] ?? -1];
    if (from === undefined || to === undefined) continue;
    gapDays.push(daysBetween(from, to));
  }

  return {
    interval: candidate.interval,
    anchor,
    gapDays,
    jitterScore: best.jitterScore,
    missedPeriods: best.missed,
    matchedIndices: best.members
      .map((position) => order[position])
      .filter((index): index is number => index !== undefined)
      .sort((a, b) => a - b),
  };
}

/**
 * The date the next charge is expected on.
 *
 * Projected from the anchor rather than from `lastSeen`, so month-end clamping survives: an
 * anchor of Jan 31 last seen on Feb 28 is next expected on Mar 31, not Mar 28.
 *
 * A charge due *today* has not necessarily posted yet, so today is a valid answer and the floor
 * is yesterday. For a subscription that stopped, this keeps returning the next date it *would*
 * have been charged — the caller reports that as paused or lapsed rather than pretending the
 * charge is coming.
 */
export function projectNextExpected(
  anchor: PlainDate,
  interval: RecurrenceInterval,
  lastSeen: PlainDate,
  today: PlainDate,
): PlainDate {
  const yesterday = addDays(today, -1);
  const floor = isAfter(lastSeen, yesterday) ? lastSeen : yesterday;
  return nextOccurrenceAfter(anchor, interval, floor);
}
