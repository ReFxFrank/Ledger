/**
 * The decision half of `pnpm keys:rotate`.
 *
 * The CLI that walks the database lives in `@ledger/db` — it needs a Postgres driver, and this
 * package deliberately has none. What lives here is everything that can be decided without IO:
 * given a sealed row and a keyring, does it rotate, is it already current, or can it not be
 * opened at all? Keeping that decision pure is what makes it testable without a database, and
 * what guarantees a `--dry-run` classifies rows exactly as the real run would.
 */

import { type Keyring, type SealedValue, reseal } from './envelope';

/** One sealed database row, addressed well enough to open and to report. */
export interface SealedRecord {
  /** Primary key — used for the optimistic UPDATE and for naming the row in the report. */
  readonly id: string;
  /** The `key_id` column: which KEK sealed the current ciphertext. */
  readonly keyId: string;
  readonly ciphertext: string;
  /** Must be byte-identical to the AAD used at seal time, or the open fails authentication. */
  readonly aad: Buffer;
}

export type ResealDecision =
  | {
      readonly kind: 'rotate';
      readonly id: string;
      /** The key id the row was read under — the optimistic-concurrency token for the UPDATE. */
      readonly fromKeyId: string;
      readonly sealed: SealedValue;
    }
  | { readonly kind: 'current'; readonly id: string }
  | {
      readonly kind: 'unopenable';
      readonly id: string;
      readonly keyId: string;
      readonly reason: string;
    };

/**
 * Classifies one row. Never throws.
 *
 * An unopenable row is data for the report, not a reason to stop: aborting a rotation at row N
 * of 10,000 because one row's KEK is missing would leave 9,999 rows un-rotated over a problem
 * that re-running cannot fix. The runbook explains what an unopenable row means and what to do;
 * the rotation's job is to name it and keep going.
 */
export function decideReseal(keyring: Keyring, record: SealedRecord): ResealDecision {
  try {
    const sealed = reseal(
      keyring,
      { keyId: record.keyId, ciphertext: record.ciphertext },
      record.aad,
    );
    if (sealed === null) return { kind: 'current', id: record.id };
    return { kind: 'rotate', id: record.id, fromKeyId: record.keyId, sealed };
  } catch (error) {
    return {
      kind: 'unopenable',
      id: record.id,
      keyId: record.keyId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface RotationFailure {
  readonly id: string;
  readonly keyId: string;
  readonly reason: string;
}

/**
 * Running totals for one sealed column. Mutable on purpose: the walk is incremental and a table
 * can be large, so the CLI records each decision as it goes rather than accumulating them.
 */
export interface RotationTally {
  total: number;
  rotated: number;
  alreadyCurrent: number;
  failures: RotationFailure[];
}

export function createTally(): RotationTally {
  return { total: 0, rotated: 0, alreadyCurrent: 0, failures: [] };
}

export function recordDecision(tally: RotationTally, decision: ResealDecision): void {
  tally.total += 1;
  switch (decision.kind) {
    case 'rotate':
      tally.rotated += 1;
      break;
    case 'current':
      tally.alreadyCurrent += 1;
      break;
    case 'unopenable':
      tally.failures.push({ id: decision.id, keyId: decision.keyId, reason: decision.reason });
      break;
  }
}
