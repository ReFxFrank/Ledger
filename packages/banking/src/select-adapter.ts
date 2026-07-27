/**
 * Which adapter this process runs with.
 *
 * `AGGREGATOR=fixture` is the default in `.env.example` and in `@ledger/env`, and that default is
 * deliberate: a fresh clone boots, connects a "bank", and shows two years of subscriptions
 * without anyone having a Plaid account. Choosing `plaid` is an explicit act, and choosing it
 * without credentials fails here — loudly, at construction — rather than as an opaque 400
 * halfway through a user's Link flow.
 *
 * The env shape is declared structurally rather than imported from `@ledger/env`. This package
 * has no reason to depend on the whole environment schema, and taking a plain object means a
 * test can pick an adapter without a `.env` file.
 */

import type { Clock } from '@ledger/core';
import type { Keyring } from '@ledger/crypto';

import { AggregatorError, type AggregatorAdapter } from './adapter';
import { FixtureAdapter, type FixtureAdapterOptions } from './fixture-adapter';
import { PlaidAdapter, type PlaidAdapterOptions } from './plaid-adapter';

export interface AdapterEnv {
  readonly AGGREGATOR?: string;
  readonly PLAID_CLIENT_ID?: string | undefined;
  readonly PLAID_SECRET?: string | undefined;
  readonly PLAID_ENV?: string | undefined;
  readonly PLAID_WEBHOOK_SECRET?: string | undefined;
  readonly APP_URL?: string | undefined;
}

export interface SelectAdapterOptions {
  readonly clock?: Clock;
  readonly keyring?: Keyring;
  /** Seed for the fixture corpus. Fixed by default, so demos are reproducible. */
  readonly fixtureSeed?: number;
}

export function selectAdapter(
  env: AdapterEnv,
  options: SelectAdapterOptions = {},
): AggregatorAdapter {
  const name = (env.AGGREGATOR ?? 'fixture').trim().toLowerCase();

  switch (name) {
    case 'fixture':
      return new FixtureAdapter(
        compact<FixtureAdapterOptions>({
          clock: options.clock,
          keyring: options.keyring,
          seed: options.fixtureSeed,
          // Reuses the same variable so that a deployment which has configured webhook signing
          // gets it on both adapters. Unset — the normal local case — the fixture accepts
          // unsigned deliveries, which is what makes `curl` a usable way to trigger a sync.
          webhookSecret: env.PLAID_WEBHOOK_SECRET,
        }),
      );

    case 'plaid':
      return new PlaidAdapter(
        compact<PlaidAdapterOptions>({
          clientId: env.PLAID_CLIENT_ID,
          secret: env.PLAID_SECRET,
          environment: plaidEnvironment(env.PLAID_ENV),
          clock: options.clock,
          keyring: options.keyring,
          // Plaid posts here; the route verifies the signature before anything else happens.
          webhookUrl:
            env.APP_URL === undefined ? undefined : `${trimSlash(env.APP_URL)}/api/webhooks/plaid`,
        }),
      );

    default:
      throw new AggregatorError(
        name,
        'not_configured',
        `Unknown AGGREGATOR=${name}. Supported values are 'fixture' and 'plaid'.`,
      );
  }
}

function plaidEnvironment(value: string | undefined): 'sandbox' | 'development' | 'production' {
  if (value === 'development' || value === 'production') return value;
  return 'sandbox';
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Drops undefined entries.
 *
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and undefined", and every
 * adapter option here means "use the default" when absent — so passing an explicit `undefined`
 * would be a type error rather than the no-op it reads as.
 */
function compact<T extends object>(values: { readonly [K in keyof T]?: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}
