import 'server-only';

import type { LinkSession, SyncResult } from '@ledger/banking';

/**
 * The decisions the connect-a-bank flow makes, with no IO in any of them.
 *
 * Same split as `@ledger/banking/sync.ts`: the arguable parts are pure functions here, and
 * `runtime.ts` is the thinnest possible layer of statements that runs them. That is what makes
 * this testable without Postgres, without Redis, and without a session — which matters
 * disproportionately for this flow, because the alternative is proving it works by connecting a
 * bank and looking at the screen.
 */

// ── the link handoff ───────────────────────────────────────────────────────────────────

/**
 * What the client has to do with a link token.
 *
 *  - `handoff`  — the aggregator hosts the flow. The token goes to its client SDK, the user signs
 *                 in at their bank, and the SDK hands back a *different*, single-use public token.
 *                 Plaid works this way and Ledger never sees the credentials in between.
 *  - `immediate`— there is no hosted flow. The session already carries everything `exchangeToken`
 *                 needs.
 */
export type LinkMode = 'handoff' | 'immediate';

/** Providers that host their own sign-in flow. Everything not listed completes immediately. */
const HOSTED_FLOW_PROVIDERS: readonly string[] = ['plaid'];

export interface LinkHandoff {
  readonly provider: string;
  readonly linkToken: string;
  readonly expiresAt: Date;
  readonly mode: LinkMode;
  /**
   * Present only in `immediate` mode, and it is the honest thing to send.
   *
   * The fixture has no bank to sign into, so pretending there is a Link handoff would mean
   * inventing a modal, a fake institution picker, and a fake public token — three lies whose only
   * purpose would be to make the fixture path *look* like the Plaid path while testing none of
   * it. The shape says which it is instead, and the client branches on `mode`.
   */
  readonly publicToken: string | null;
}

export function planLinkHandoff(session: LinkSession): LinkHandoff {
  const mode: LinkMode = HOSTED_FLOW_PROVIDERS.includes(session.provider) ? 'handoff' : 'immediate';
  return {
    provider: session.provider,
    linkToken: session.linkToken,
    expiresAt: session.expiresAt,
    mode,
    publicToken: mode === 'immediate' ? session.linkToken : null,
  };
}

// ── claiming the connection row ────────────────────────────────────────────────────────

/**
 * What happened when we tried to write the `bank_connections` row.
 *
 * `bank_connections_item_unique` is on `(provider, external_item_id)` and is deliberately not
 * scoped to a user — one aggregator link is one row, globally. So an insert that conflicts has
 * exactly two meanings and they need opposite handling: the same person reconnecting the same
 * bank (fine, reuse the row and re-sync it) or a token that resolves to somebody else's link
 * (never fine, and must not be reported as "already connected" either, because that would
 * confirm the existence of another account's connection).
 */
export type ConnectionClaim =
  | { readonly kind: 'created'; readonly connectionId: string }
  | { readonly kind: 'relinked'; readonly connectionId: string }
  | { readonly kind: 'taken' };

export function claimConnection(
  inserted: { readonly id: string } | undefined,
  existing: { readonly id: string; readonly userId: string } | undefined,
  userId: string,
): ConnectionClaim {
  if (inserted !== undefined) return { kind: 'created', connectionId: inserted.id };
  if (existing?.userId === userId) return { kind: 'relinked', connectionId: existing.id };
  return { kind: 'taken' };
}

// ── the inline run budget ──────────────────────────────────────────────────────────────

/**
 * How many times one request will call `syncConnection` before giving up and reporting `hasMore`.
 *
 * `syncConnection` already bounds itself at `DEFAULT_MAX_PAGES` (40) pages and returns
 * `hasMore: true` when the aggregator had more — that bound exists so one connection cannot own a
 * worker for an hour. Running it in a request needs a *second* bound on top, because a request is
 * a much shorter thing than a job. Eight runs is ~320 pages, which drains the 24-month fixture
 * (roughly eleven pages) many times over while still refusing to sit on a Plaid backfill forever.
 */
export const MAX_INLINE_RUNS = 8;

/** Continue only while the aggregator says there is more *and* the budget has not run out. */
export function shouldContinueInline(
  result: Pick<SyncResult, 'hasMore'>,
  runsCompleted: number,
  maxRuns: number = MAX_INLINE_RUNS,
): boolean {
  if (!result.hasMore) return false;
  return runsCompleted < maxRuns;
}

// ── folding several runs into one answer ───────────────────────────────────────────────

export interface SyncTotals {
  readonly pages: number;
  readonly added: number;
  readonly updated: number;
  readonly settled: number;
  readonly removed: number;
  /** Detections that did not exist before this connect. What "we found N subscriptions" counts. */
  readonly detectionsFound: number;
  /** Every candidate the detector currently stands behind, new or not. */
  readonly detectionsTotal: number;
  readonly backfillCompleted: boolean;
  readonly hasMore: boolean;
}

/**
 * Folds a sequence of runs into the numbers a person reads.
 *
 * The two detection figures are aggregated differently on purpose, and getting it the other way
 * round is the bug this function exists to have a test for. `reconcileDetections` re-runs over the
 * user's *whole* history at the end of every run, so `candidates` is a snapshot — summing it
 * across four runs would report four times the subscriptions the user has. `newKeys` is a
 * difference against what was already stored, so it only counts on the run that first saw each
 * key, and summing it is exactly right.
 */
export function accumulate(results: readonly SyncResult[]): SyncTotals {
  const last = results[results.length - 1];

  let pages = 0;
  let added = 0;
  let updated = 0;
  let settled = 0;
  let removed = 0;
  let detectionsFound = 0;
  let backfillCompleted = false;

  for (const result of results) {
    pages += result.pages;
    added += result.inserted;
    updated += result.updated;
    settled += result.settled;
    removed += result.removed;
    detectionsFound += result.detections?.newKeys ?? 0;
    backfillCompleted ||= result.backfillCompleted;
  }

  return {
    pages,
    added,
    updated,
    settled,
    removed,
    detectionsFound,
    detectionsTotal: last?.detections?.candidates ?? 0,
    backfillCompleted,
    hasMore: last?.hasMore ?? false,
  };
}
