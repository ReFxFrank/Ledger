/**
 * @ledger/detection — transactions in, subscription candidates out.
 *
 * Pure by construction: no IO, no clock, no database, no dependency beyond `@ledger/core`
 * (brief §4, enforced by the ESLint boundary in the repo root config). Every decision this
 * package makes is reproducible from a JSON file, which is the only reason detection quality is
 * testable at all.
 *
 * `detectSubscriptions` is the entry point. The stages below it are exported individually
 * because the review UI and the test suite both need to reason about one stage at a time — a
 * cadence bug should be reproducible from a list of dates, without a transaction fixture.
 */

export * from './types';
export * from './normalize';
export * from './match';
export * from './cluster';
export * from './cadence';
export * from './confidence';
export * from './edge-cases';
export * from './detect';
