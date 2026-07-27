/**
 * The aggregator seam (brief §4.1).
 *
 * Everything below this file talks to a bank. Everything above it talks to `AggregatorAdapter`
 * and the neutral DTOs declared here. That boundary is not decoration: Plaid is one of at least
 * three shapes this product will eventually speak (TrueLayer and GoCardless both use the
 * opposite amount sign and a different consent model), and the fixture adapter has to be a peer
 * of the real one rather than a mock bolted on for tests. A Plaid type that leaks past this file
 * is a migration we will pay for later.
 *
 * ## The sign convention
 *
 * **Positive means money leaving the account.** Every adapter normalises to that here, at the
 * boundary, before a row reaches the sync engine or the detector.
 *
 * This is the single most dangerous piece of implicit knowledge in the codebase. Aggregators do
 * not agree: Plaid reports outflows as positive ("debit card purchases are positive; credit card
 * payments, direct deposits, and refunds are negative" — `Transaction.amount` in the SDK types,
 * verified against `plaid@28`), while most Open Banking APIs report a debit as negative. Pick the
 * wrong one and nothing crashes. Every subscription simply becomes a refund: the clusterer sees
 * negative amounts, the reversal pass pairs them off, the detector reports "no subscriptions
 * found", and the product looks like it works and finds nothing. There is no stack trace for
 * that, which is why the convention is stated in a constant, applied through one function, and
 * asserted in `adapter.test.ts` rather than trusted to a comment in each adapter.
 *
 * A negative amount downstream therefore means exactly one thing: money arrived. A refund, a
 * salary, a transfer in.
 */

import {
  type PlainDate,
  LedgerError,
  currency,
  isCurrencyCode,
  minorUnitExponent,
} from '@ledger/core';
import { aadFor } from '@ledger/crypto';

// ── the sign convention ────────────────────────────────────────────────────────────────

/**
 * Which way an upstream API signs a debit.
 *
 * Named rather than boolean because `normalizeSign(amount, true)` at a call site tells a reader
 * nothing, and this is the one parameter in the package where being wrong is silent.
 */
export type AmountSignConvention =
  /** A debit (money out) arrives positive. Plaid. */
  | 'positive-outflow'
  /** A debit arrives negative. Most Open Banking / PSD2 APIs. */
  | 'negative-outflow';

/** The convention every DTO in this file uses, restated where a reader will trip over it. */
export const LEDGER_SIGN_CONVENTION = 'positive-outflow' satisfies AmountSignConvention;

/**
 * Converts an upstream amount into the Ledger convention.
 *
 * Integer in, integer out — money never becomes a float on this path.
 */
export function toOutflowMinor(amountMinor: number, convention: AmountSignConvention): number {
  if (!Number.isInteger(amountMinor)) {
    throw new LedgerError('INVALID_ARGUMENT', 'Transaction amounts are integer minor units.');
  }
  if (convention === LEDGER_SIGN_CONVENTION) return amountMinor;
  // `-0` is a real value in JS and it round-trips through JSON as `0` but compares unequal under
  // `Object.is`. A zero-amount authorization hold is common enough to be worth the branch.
  return amountMinor === 0 ? 0 : -amountMinor;
}

/**
 * Quantises an upstream decimal amount to integer minor units.
 *
 * Aggregators send money as a JSON number — `17.99` — and there is no way to avoid one float
 * crossing the boundary. This is the only place it is allowed to, and it is quantised
 * immediately: `toFixed` at the currency's exponent, then integer parsing of the digits. Nothing
 * downstream ever sees the double. JPY has no minor unit and KWD has three, so the exponent
 * comes from the currency table rather than a hardcoded 100.
 *
 * Unknown currency codes fall back to two digits: bank feeds emit junk codes, and refusing the
 * whole page because one row said `XXX` loses real transactions.
 */
export function minorUnitsFromDecimal(amount: number, currencyCode: string): number {
  if (!Number.isFinite(amount)) {
    throw new LedgerError('INVALID_ARGUMENT', 'Transaction amount is not a finite number.');
  }
  const exponent = isCurrencyCode(currencyCode) ? minorUnitExponent(currency(currencyCode)) : 2;
  const fixed = amount.toFixed(exponent);
  const negative = fixed.startsWith('-');
  const digits = (negative ? fixed.slice(1) : fixed).replace('.', '');
  const minor = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(minor)) {
    throw new LedgerError('MONEY_OVERFLOW', 'Transaction amount does not fit in a safe integer.');
  }
  return negative && minor !== 0 ? -minor : minor;
}

// ── neutral DTOs ───────────────────────────────────────────────────────────────────────

/** One account at the institution, reduced to what `bank_accounts` stores. */
export interface AggregatorAccount {
  /** The aggregator's stable id for this account. Unique within a connection. */
  readonly externalId: string;
  readonly name: string;
  readonly officialName: string | null;
  /** Display-only last few digits. Never a full account number — see the schema note. */
  readonly mask: string | null;
  /** `depository` | `credit` | `loan` | `investment` | `other`. */
  readonly type: string;
  readonly subtype: string | null;
  /** ISO-4217, uppercase. Not narrowed — an institution may report an unofficial code. */
  readonly currency: string;
}

/**
 * One transaction, already normalised.
 *
 * `postedAt` is a `PlainDate` rather than a timestamp because that is what banks actually know:
 * a posting date, not an instant. The engine converts to UTC midnight at the database boundary.
 */
export interface AggregatorTransaction {
  readonly externalId: string;
  /** `AggregatorAccount.externalId`, not a local uuid — the adapter has never seen our ids. */
  readonly accountExternalId: string;
  readonly postedAt: PlainDate;
  readonly authorizedAt: PlainDate | null;
  /** Integer minor units. **Positive = money leaving the account.** See the file header. */
  readonly amountMinor: number;
  readonly currency: string;
  /** Exactly as the institution sent it. The evidence for the descriptor decoder. */
  readonly rawDescriptor: string;
  readonly pending: boolean;
  /**
   * A deliberately small, allow-listed slice of the upstream payload.
   *
   * Not the whole object: an aggregator adding a field is not permission to store it, and the
   * only defensible answer to "what personal data is in this jsonb column" is a list.
   */
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * One page of incremental changes.
 *
 * `nextCursor` is meaningful even when `hasMore` is false — it is the resume point for the next
 * sync, and persisting it is what makes a killed worker safe.
 */
export interface SyncPage {
  readonly added: readonly AggregatorTransaction[];
  readonly modified: readonly AggregatorTransaction[];
  /** External ids the aggregator has retracted. Usually an authorization that never settled. */
  readonly removed: readonly string[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

/** What a webhook means, independent of which aggregator sent it. */
export const WEBHOOK_KINDS = [
  /** New transactions are available; run a sync. */
  'sync_updates',
  /** The initial historical pull has finished. */
  'historical_ready',
  /** The user must sign in again before the next sync can succeed. */
  'reauth_required',
  /** Consent is approaching its expiry date. */
  'consent_expiring',
  /** The link was removed at the aggregator or by the institution. */
  'item_removed',
  /** The aggregator is reporting a persistent error on this link. */
  'error',
  /** Understood, verified, and not actionable. */
  'other',
] as const;

export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

/**
 * A verified webhook delivery.
 *
 * `externalId` is the replay key. It must be identical for a retransmission of the same delivery
 * and different for a genuinely new one — the unique index on `(provider, external_id)` is what
 * stops a retry from running a second sync, and it can only do that if this field is honest.
 */
export interface WebhookEvent {
  readonly provider: string;
  readonly externalId: string;
  /** The aggregator's link id, when the event is about one link. */
  readonly itemExternalId: string | null;
  /** The provider's own event name, kept verbatim for the audit trail. */
  readonly type: string;
  readonly kind: WebhookKind;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface LinkSessionOptions {
  /** Where the aggregator should post webhooks for links created in this session. */
  readonly webhookUrl?: string;
  readonly redirectUri?: string;
  /** BCP-47-ish language tag the hosted flow should render in. */
  readonly locale?: string;
  /** ISO-3166-1 alpha-2. Which countries' institutions to offer. */
  readonly countryCodes?: readonly string[];
  /** Skip the institution picker — used by "reconnect this bank". */
  readonly institutionId?: string;
  /** Shown inside the aggregator's hosted flow. */
  readonly clientName?: string;
}

export interface LinkSession {
  readonly provider: string;
  /** Short-lived, client-visible, and not a credential for anything but this one flow. */
  readonly linkToken: string;
  readonly expiresAt: Date;
}

/**
 * The result of exchanging a public token — everything `bank_connections` needs for one row.
 *
 * Note what is *not* here: the access token in plaintext. `exchangeToken` seals it before it
 * returns, so the token never crosses a package boundary and no caller can log it by accident.
 * The caller writes the ciphertext and the key id straight into the row.
 */
export interface LinkedItem {
  readonly provider: string;
  readonly externalItemId: string;
  readonly institutionId: string | null;
  readonly institutionName: string;
  readonly institutionLogo: string | null;
  readonly accessTokenCiphertext: string;
  readonly keyId: string;
  /** Open-banking consent deadline, when the aggregator reports one. */
  readonly consentExpiresAt: Date | null;
}

/**
 * The subset of a `bank_connections` row an adapter is allowed to see.
 *
 * A row from the database satisfies this structurally, so callers pass the row; but an adapter
 * cannot reach the user id, the cursor, or anything else it has no business knowing.
 */
export interface AggregatorConnection {
  readonly id: string;
  readonly provider: string;
  readonly externalItemId: string;
  readonly accessTokenCiphertext: string;
  readonly keyId: string;
}

// ── AAD ────────────────────────────────────────────────────────────────────────────────

const ACCESS_TOKEN_TABLE = 'bank_connections';
const ACCESS_TOKEN_COLUMN = 'access_token_ciphertext';

/**
 * The additional authenticated data binding a sealed access token to its connection.
 *
 * The row identity is `provider:externalItemId` rather than the local uuid, because the token
 * has to be sealed *before* the row exists — `exchangeToken` runs, then the row is inserted with
 * the ciphertext already in it. `bank_connections_item_unique` makes that pair exactly as unique
 * as the primary key, so the guarantee is unchanged: ciphertext lifted from one connection and
 * pasted into another fails authentication instead of decrypting.
 */
export function accessTokenAad(provider: string, externalItemId: string): Buffer {
  return aadFor(ACCESS_TOKEN_TABLE, `${provider}:${externalItemId}`, ACCESS_TOKEN_COLUMN);
}

// ── errors ─────────────────────────────────────────────────────────────────────────────

/**
 * Neutral failure codes. `health.ts` maps these to a connection status the user sees.
 *
 * Kept small on purpose: the question the UI asks is "can the user fix this, and how", and there
 * are only a few answers.
 */
export const AGGREGATOR_ERROR_CODES = [
  /** The user must re-authenticate. Actionable now. */
  'reauth_required',
  /** Consent has lapsed and a new link is required. Actionable now. */
  'consent_expired',
  /** The link no longer exists at the aggregator. */
  'item_not_found',
  /** The institution is down or the aggregator is throttling. Retry later. */
  'temporarily_unavailable',
  'rate_limited',
  /** The delivery failed verification. Never retried, never trusted. */
  'invalid_webhook',
  /** The adapter is missing configuration it needs. A deployment problem, not a user problem. */
  'not_configured',
  /** Anything else the upstream reported. */
  'upstream',
] as const;

export type AggregatorErrorCode = (typeof AGGREGATOR_ERROR_CODES)[number];

/** Codes that mean "the user has to go and sign in again". Read by `health.ts`. */
export const REAUTH_ERROR_CODES: readonly AggregatorErrorCode[] = [
  'reauth_required',
  'item_not_found',
];

/** Codes worth trying again on a later run rather than surfacing to the user immediately. */
export const RETRYABLE_ERROR_CODES: readonly AggregatorErrorCode[] = [
  'temporarily_unavailable',
  'rate_limited',
];

export function isRetryable(code: AggregatorErrorCode): boolean {
  return RETRYABLE_ERROR_CODES.includes(code);
}

/**
 * A failure from an aggregator, with everything sensitive already removed.
 *
 * Construction is the sanitisation point. The upstream SDK's error object carries the *request*
 * — which carries the access token — so it is deliberately never attached as `cause`. A logger
 * that walks the cause chain would otherwise print a live bank credential, and the redaction
 * list in `@ledger/logger` is the second line of defence, not the first.
 */
export class AggregatorError extends LedgerError {
  readonly aggregatorCode: AggregatorErrorCode;
  readonly provider: string;
  readonly retryable: boolean;

  constructor(
    provider: string,
    aggregatorCode: AggregatorErrorCode,
    message: string,
    meta: Readonly<Record<string, unknown>> = {},
  ) {
    super(aggregatorCode === 'not_configured' ? 'CONFIGURATION_ERROR' : 'UPSTREAM_ERROR', message, {
      meta: { ...meta, provider, aggregatorCode },
    });
    this.name = 'AggregatorError';
    this.provider = provider;
    this.aggregatorCode = aggregatorCode;
    this.retryable = isRetryable(aggregatorCode);
  }
}

export function isAggregatorError(value: unknown): value is AggregatorError {
  return value instanceof AggregatorError;
}

// ── the adapter ────────────────────────────────────────────────────────────────────────

/**
 * The whole surface an aggregator has to implement (brief §4.1).
 *
 * Six methods. Notably absent, and absent permanently: anything that signs into a provider as
 * the user, stores a provider password, or drives a browser at an account page. Ledger reads a
 * bank feed the user has consented to share and nothing else.
 */
export interface AggregatorAdapter {
  /** `plaid` | `fixture` | … . Written to `bank_connections.provider`. */
  readonly provider: string;

  /**
   * Starts a hosted link flow. The returned token is handed to the client SDK; it is not a
   * credential for anything else and expires within hours.
   */
  createLinkSession(userId: string, options: LinkSessionOptions): Promise<LinkSession>;

  /**
   * Trades the public token the client produced for a durable link.
   *
   * The access token is sealed inside the implementation and returned only as ciphertext.
   */
  exchangeToken(publicToken: string): Promise<LinkedItem>;

  /**
   * One page of incremental changes from `cursor`. `null` means "from the beginning".
   */
  syncTransactions(connection: AggregatorConnection, cursor: string | null): Promise<SyncPage>;

  getAccounts(connection: AggregatorConnection): Promise<readonly AggregatorAccount[]>;

  /**
   * Verifies a delivery and reduces it to a neutral event.
   *
   * Takes the *raw* body, because every signature scheme worth having is computed over the bytes
   * as sent — re-serialising parsed JSON changes them. Throws `invalid_webhook` rather than
   * returning a flag: an unverified delivery has no fields worth reading.
   */
  handleWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string | undefined>>,
  ): Promise<WebhookEvent>;

  /** Revokes the link upstream. Local rows are the caller's problem. */
  removeConnection(connection: AggregatorConnection): Promise<void>;
}
