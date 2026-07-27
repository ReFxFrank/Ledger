/**
 * The revoke half of account deletion.
 *
 * `deleteAccount` revokes upstream FIRST and deletes local rows second, and what it does on a
 * partial failure — proceed for the revoked, abort for the failed — hangs entirely on this
 * report being right. Adapters are injected, so none of this needs Postgres or a Plaid
 * credential; the router's contribution is a select, a delete, and a throw.
 */

import { describe, expect, it } from 'vitest';
import { type AggregatorAdapter, type AggregatorConnection, AggregatorError } from '@ledger/banking';
import { type RevocableConnection, revokeConnections } from '~/server/banking/revoke';

function connection(overrides: Partial<RevocableConnection> = {}): RevocableConnection {
  return {
    id: 'conn-1',
    provider: 'plaid',
    externalItemId: 'item-1',
    institutionName: 'First Platypus Bank',
    accessTokenCiphertext: 'sealed',
    keyId: 'key-1',
    ...overrides,
  };
}

/** An adapter whose `removeConnection` is scripted per external item id. */
function adapter(
  provider: string,
  behaviour: (connection: AggregatorConnection) => Promise<void>,
  calls?: string[],
): AggregatorAdapter {
  return {
    provider,
    createLinkSession: () => Promise.reject(new Error('not under test')),
    exchangeToken: () => Promise.reject(new Error('not under test')),
    syncTransactions: () => Promise.reject(new Error('not under test')),
    getAccounts: () => Promise.reject(new Error('not under test')),
    handleWebhook: () => Promise.reject(new Error('not under test')),
    removeConnection: (target) => {
      calls?.push(`${provider}:${target.externalItemId}`);
      return behaviour(target);
    },
  };
}

const succeeds = (provider: string, calls?: string[]) =>
  adapter(provider, () => Promise.resolve(), calls);

const failsWith = (provider: string, error: unknown) =>
  adapter(provider, () => Promise.reject(error instanceof Error ? error : new Error(String(error))));

describe('revokeConnections', () => {
  it('revokes every connection and reports no failures on the happy path', async () => {
    const calls: string[] = [];
    const instance = succeeds('plaid', calls);

    const report = await revokeConnections(
      [connection({ externalItemId: 'item-1' }), connection({ id: 'conn-2', externalItemId: 'item-2' })],
      () => instance,
    );

    expect(calls).toEqual(['plaid:item-1', 'plaid:item-2']);
    expect(report.revoked.map((link) => link.id)).toEqual(['conn-1', 'conn-2']);
    expect(report.failed).toEqual([]);
  });

  it('splits a partial failure into both halves rather than failing the lot', async () => {
    const upstream = new AggregatorError('plaid', 'temporarily_unavailable', 'Institution is down.');
    const instance = adapter('plaid', (target) =>
      target.externalItemId === 'item-2' ? Promise.reject(upstream) : Promise.resolve(),
    );

    const report = await revokeConnections(
      [
        connection({ id: 'conn-1', externalItemId: 'item-1', institutionName: 'Alpha Bank' }),
        connection({ id: 'conn-2', externalItemId: 'item-2', institutionName: 'Beta Bank' }),
        connection({ id: 'conn-3', externalItemId: 'item-3', institutionName: 'Gamma Bank' }),
      ],
      () => instance,
    );

    // The failed one is named for the PRECONDITION_FAILED message; the revoked ones are the rows
    // the router must delete immediately so a retry does not re-revoke dead items.
    expect(report.revoked.map((link) => link.institutionName)).toEqual(['Alpha Bank', 'Gamma Bank']);
    expect(report.failed.map(({ connection: link }) => link.institutionName)).toEqual(['Beta Bank']);
  });

  it('treats an item the aggregator no longer has as revoked, not failed', async () => {
    // The consent this loop exists to withdraw is already withdrawn — counting it as a failure
    // would permanently block deletion for a user whose bank removed the link on its side.
    const instance = failsWith('plaid', new AggregatorError('plaid', 'item_not_found', 'Gone.'));

    const report = await revokeConnections([connection()], () => instance);

    expect(report.revoked).toHaveLength(1);
    expect(report.failed).toEqual([]);
  });

  it('counts a connection whose adapter cannot even be built as failed, and keeps going', async () => {
    // A fixture row after AGGREGATOR flipped, with no fixture credentials left: `getAdapterFor`
    // throws. That connection cannot be revoked, but the Plaid one after it still must be.
    const plaid = succeeds('plaid');

    const report = await revokeConnections(
      [
        connection({ id: 'conn-f', provider: 'fixture', institutionName: 'Fixture Bank' }),
        connection({ id: 'conn-p', provider: 'plaid', institutionName: 'Real Bank' }),
      ],
      (provider) => {
        if (provider !== 'plaid') throw new Error('FIXTURE_WEBHOOK_SECRET is not configured');
        return plaid;
      },
    );

    expect(report.revoked.map((link) => link.id)).toEqual(['conn-p']);
    expect(report.failed.map(({ connection: link }) => link.institutionName)).toEqual([
      'Fixture Bank',
    ]);
    expect(report.failed[0]?.reason).toContain('not configured');
  });

  it('routes each connection to the adapter for its own provider, never one shared instance', async () => {
    const calls: string[] = [];
    const byProvider = new Map<string, AggregatorAdapter>([
      ['plaid', succeeds('plaid', calls)],
      ['fixture', succeeds('fixture', calls)],
    ]);

    const report = await revokeConnections(
      [
        connection({ id: 'conn-p', provider: 'plaid', externalItemId: 'item-p' }),
        connection({ id: 'conn-f', provider: 'fixture', externalItemId: 'item-f' }),
      ],
      (provider) => {
        const found = byProvider.get(provider);
        if (found === undefined) throw new Error(`no adapter for ${provider}`);
        return found;
      },
    );

    expect(calls).toEqual(['plaid:item-p', 'fixture:item-f']);
    expect(report.failed).toEqual([]);
  });

  it('returns an empty report for a user with no connections', async () => {
    const report = await revokeConnections([], () => {
      throw new Error('should never be asked for an adapter');
    });

    expect(report).toEqual({ revoked: [], failed: [] });
  });
});
