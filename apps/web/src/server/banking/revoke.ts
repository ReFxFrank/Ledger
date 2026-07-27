import 'server-only';

import {
  type AggregatorAdapter,
  type AggregatorConnection,
  isAggregatorError,
} from '@ledger/banking';
import { type Database, type Scope, bankConnections } from '@ledger/db';
import { childLogger } from '@ledger/logger';

const log = childLogger('web.banking.revoke');

/**
 * Upstream revocation for account deletion.
 *
 * Separated from the mutation body for the same reason as `plan.ts`: the arguable part — what
 * counts as revoked, what a partial failure means — is a function over an injected adapter
 * resolver, so the behaviour tests need neither Postgres nor a Plaid credential. The router
 * passes `getAdapterFor` from `runtime.ts`; the tests pass fakes.
 */

/** What `deleteAccount` reads per connection: enough for the adapter, plus a name for the user. */
export interface RevocableConnection extends AggregatorConnection {
  readonly institutionName: string;
}

/**
 * Every connection of the scoped user, with the sealed token columns the adapter needs.
 *
 * This select lives here rather than in the router on purpose: `authz.test.ts` scans the router
 * sources and fails the build if either sealed column is ever named there, and that ban is worth
 * keeping absolute. Account deletion is the one flow that must read them — so it reads them in
 * the banking layer, hands them straight to the adapter, and the ciphertext never appears in a
 * file whose job is building responses.
 */
export async function loadRevocableConnections(
  db: Database,
  scope: Scope,
): Promise<RevocableConnection[]> {
  return db
    .select({
      id: bankConnections.id,
      provider: bankConnections.provider,
      externalItemId: bankConnections.externalItemId,
      institutionName: bankConnections.institutionName,
      accessTokenCiphertext: bankConnections.accessTokenCiphertext,
      keyId: bankConnections.keyId,
    })
    .from(bankConnections)
    .where(scope.where(bankConnections));
}

export interface FailedRevocation {
  readonly connection: RevocableConnection;
  /** For the log line and the audit trail — never shown verbatim to the user. */
  readonly reason: string;
}

export interface RevocationReport {
  /**
   * Gone upstream. The caller must delete these local rows even when the overall deletion
   * aborts — their tokens are dead, and a retry that re-revoked them would either fail on a
   * token the aggregator no longer honours or, worse, block the whole deletion on rows that
   * are already handled.
   */
  readonly revoked: readonly RevocableConnection[];
  readonly failed: readonly FailedRevocation[];
}

/**
 * Revokes every connection upstream, one at a time, and reports both halves.
 *
 * Sequential rather than `Promise.all`: an account has a handful of connections at most, and a
 * per-connection outcome is the whole point — `allSettled` would work too, but interleaved
 * adapter calls make the failure logs unattributable when two share a provider.
 *
 * Nothing here throws for a single bad connection. Even the adapter *resolver* failing (a
 * provider with no credentials configured) is a failed revocation of that connection, not an
 * abort of the loop — the other institutions still deserve their revoke.
 */
export async function revokeConnections(
  connections: readonly RevocableConnection[],
  adapterFor: (provider: string) => AggregatorAdapter,
): Promise<RevocationReport> {
  const revoked: RevocableConnection[] = [];
  const failed: FailedRevocation[] = [];

  for (const connection of connections) {
    try {
      await adapterFor(connection.provider).removeConnection(connection);
      revoked.push(connection);
    } catch (error) {
      // An item the aggregator no longer has *is* revoked: the consent this exists to withdraw
      // is already withdrawn. Treating it as a failure would permanently block deletion for a
      // user whose bank removed the link on its side.
      if (isAggregatorError(error) && error.aggregatorCode === 'item_not_found') {
        revoked.push(connection);
        continue;
      }

      const reason = error instanceof Error ? error.message : String(error);
      log.warn(
        { connectionId: connection.id, provider: connection.provider, err: reason },
        'upstream revoke failed',
      );
      failed.push({ connection, reason });
    }
  }

  return { revoked, failed };
}
