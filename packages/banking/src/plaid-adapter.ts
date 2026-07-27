/**
 * The Plaid adapter.
 *
 * Three things in here are worth reading before changing anything.
 *
 * **1. The sign.** Plaid's `Transaction.amount` is documented in the SDK types as "Positive
 * values when money moves out of the account; negative values when money moves in. For example,
 * debit card purchases are positive; credit card payments, direct deposits, and refunds are
 * negative." That is already the Ledger convention, so the mapping is `toOutflowMinor(x,
 * 'positive-outflow')` — an identity. It is written as an explicit call rather than left out,
 * because the next adapter (TrueLayer, GoCardless) is the opposite, and a missing call is
 * indistinguishable from a deliberate one when you are reading the diff that broke it.
 *
 * **2. The access token.** It is opened here, held in a local, and never returned, logged, or
 * attached to an error. The Plaid SDK is built on axios, and an axios error carries
 * `config.data` — which is the request body — which is the access token. So no upstream error is
 * ever attached as `cause`: `sanitize()` reads the two fields worth having (`error_code`,
 * `error_message`) and throws a fresh `AggregatorError`. Redaction in `@ledger/logger` is the
 * backstop, not the mechanism.
 *
 * **3. The webhook.** Plaid signs with an ES256 JWT in the `Plaid-Verification` header whose
 * payload commits to a SHA-256 of the request body. Verifying the JWT without also comparing
 * that digest to the bytes actually received verifies nothing useful — an attacker could replay
 * a valid header over a body of their choosing. Both checks are here, plus an age bound on
 * `iat`, and the delivery id is derived from the signature so a genuine retransmission dedupes
 * and a new delivery does not.
 */

import { createHash, createPublicKey, createVerify } from 'node:crypto';
import {
  type AccountsGetRequest,
  type AccountsGetResponse,
  type InstitutionsGetByIdRequest,
  type InstitutionsGetByIdResponse,
  type ItemGetRequest,
  type ItemGetResponse,
  type ItemPublicTokenExchangeRequest,
  type ItemPublicTokenExchangeResponse,
  type ItemRemoveRequest,
  type ItemRemoveResponse,
  type LinkTokenCreateRequest,
  type LinkTokenCreateResponse,
  type Transaction as PlaidTransaction,
  type TransactionsSyncRequest,
  type TransactionsSyncResponse,
  type WebhookVerificationKeyGetRequest,
  type WebhookVerificationKeyGetResponse,
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from 'plaid';

import { type Clock, SystemClock, parsePlainDate } from '@ledger/core';
import { type Keyring, getKeyring, open, safeEqual, seal } from '@ledger/crypto';

import {
  type AggregatorAccount,
  type AggregatorAdapter,
  type AggregatorConnection,
  type AggregatorErrorCode,
  type AggregatorTransaction,
  type LinkSession,
  type LinkSessionOptions,
  type LinkedItem,
  type SyncPage,
  type WebhookEvent,
  type WebhookKind,
  AggregatorError,
  accessTokenAad,
  minorUnitsFromDecimal,
  toOutflowMinor,
} from './adapter';

export const PLAID_PROVIDER = 'plaid';

/** 24 months, per the backfill requirement. Only honoured on an Item's first pull. */
const BACKFILL_DAYS = 730;

/** Plaid's own maximum for `/transactions/sync`. */
const MAX_PAGE_SIZE = 500;

/**
 * How stale a signed webhook may be.
 *
 * Five minutes is Plaid's own recommendation and it is the window an attacker gets to replay a
 * captured delivery *at the HTTP layer*. The `webhook_deliveries` unique index closes the rest.
 */
const DEFAULT_WEBHOOK_MAX_AGE_SECONDS = 300;

/**
 * The slice of `PlaidApi` this adapter uses.
 *
 * Declared structurally so `PlaidApi` satisfies it without a cast and a test double satisfies it
 * without a network. It is also the exhaustive list of Plaid endpoints this product touches,
 * which is a thing worth being able to read in one screen.
 */
export interface PlaidClient {
  linkTokenCreate(request: LinkTokenCreateRequest): Promise<{ data: LinkTokenCreateResponse }>;
  itemPublicTokenExchange(
    request: ItemPublicTokenExchangeRequest,
  ): Promise<{ data: ItemPublicTokenExchangeResponse }>;
  itemGet(request: ItemGetRequest): Promise<{ data: ItemGetResponse }>;
  institutionsGetById(
    request: InstitutionsGetByIdRequest,
  ): Promise<{ data: InstitutionsGetByIdResponse }>;
  transactionsSync(request: TransactionsSyncRequest): Promise<{ data: TransactionsSyncResponse }>;
  accountsGet(request: AccountsGetRequest): Promise<{ data: AccountsGetResponse }>;
  itemRemove(request: ItemRemoveRequest): Promise<{ data: ItemRemoveResponse }>;
  webhookVerificationKeyGet(
    request: WebhookVerificationKeyGetRequest,
  ): Promise<{ data: WebhookVerificationKeyGetResponse }>;
}

export interface PlaidAdapterOptions {
  readonly clientId?: string;
  readonly secret?: string;
  readonly environment?: 'sandbox' | 'development' | 'production';
  /** Shown inside Plaid Link. Plaid truncates past 30 characters. */
  readonly clientName?: string;
  /** ISO-3166-1 alpha-2 codes offered in the institution picker. */
  readonly countryCodes?: readonly string[];
  readonly webhookUrl?: string;
  readonly redirectUri?: string;
  readonly pageSize?: number;
  readonly webhookMaxAgeSeconds?: number;
  readonly clock?: Clock;
  /** Injected in tests and by `keys:rotate`; otherwise the process keyring. */
  readonly keyring?: Keyring;
  /** Injected in tests. Constructed from the credentials above when absent. */
  readonly client?: PlaidClient;
}

export class PlaidAdapter implements AggregatorAdapter {
  readonly provider = PLAID_PROVIDER;

  private readonly clock: Clock;
  private readonly countryCodes: readonly CountryCode[];
  private readonly clientName: string;
  private readonly pageSize: number;
  private readonly webhookMaxAgeSeconds: number;
  private readonly webhookUrl: string | null;
  private readonly redirectUri: string | null;
  private readonly injectedKeyring: Keyring | null;
  private readonly client: PlaidClient;

  constructor(options: PlaidAdapterOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.clientName = options.clientName ?? 'Ledger';
    this.pageSize = Math.min(Math.max(options.pageSize ?? 250, 1), MAX_PAGE_SIZE);
    this.webhookMaxAgeSeconds = options.webhookMaxAgeSeconds ?? DEFAULT_WEBHOOK_MAX_AGE_SECONDS;
    this.webhookUrl = options.webhookUrl ?? null;
    this.redirectUri = options.redirectUri ?? null;
    this.injectedKeyring = options.keyring ?? null;
    this.countryCodes = (options.countryCodes ?? ['US']).map(toCountryCode);
    this.client = options.client ?? buildClient(options);
  }

  async createLinkSession(userId: string, options: LinkSessionOptions): Promise<LinkSession> {
    const countryCodes = options.countryCodes?.map(toCountryCode) ?? this.countryCodes;
    const request: LinkTokenCreateRequest = {
      client_name: options.clientName ?? this.clientName,
      language: options.locale ?? 'en',
      country_codes: [...countryCodes],
      // Plaid's `client_user_id` is an opaque correlation id. It is our own user id, which is
      // already a random string — never an email, which Plaid's docs explicitly warn against.
      user: { client_user_id: userId },
      products: [Products.Transactions],
      // Requested here rather than in `/transactions/sync`: on a fresh Item, Plaid decides how
      // much history to pull from the institution at Link time, and the sync-side
      // `days_requested` has no effect once the Item is initialised.
      transactions: { days_requested: BACKFILL_DAYS },
    };

    const webhook = options.webhookUrl ?? this.webhookUrl;
    if (webhook !== null) request.webhook = webhook;
    const redirect = options.redirectUri ?? this.redirectUri;
    if (redirect !== null) request.redirect_uri = redirect;
    if (options.institutionId !== undefined) request.institution_id = options.institutionId;

    const response = await this.call('createLinkSession', () => this.client.linkTokenCreate(request));

    return {
      provider: this.provider,
      linkToken: response.data.link_token,
      expiresAt: new Date(response.data.expiration),
    };
  }

  async exchangeToken(publicToken: string): Promise<LinkedItem> {
    const exchange = await this.call('exchangeToken', () =>
      this.client.itemPublicTokenExchange({ public_token: publicToken }),
    );
    // From here to the `seal()` below, the plaintext token exists only in this local. It is
    // deliberately not passed to a helper, stored on `this`, or included in any thrown error.
    const accessToken = exchange.data.access_token;
    const itemId = exchange.data.item_id;

    const item = await this.call('exchangeToken.itemGet', () =>
      this.client.itemGet({ access_token: accessToken }),
    );
    const institutionId = item.data.item.institution_id ?? null;
    const consent = item.data.item.consent_expiration_time;

    const institution = institutionId === null ? null : await this.fetchInstitution(institutionId);

    const sealed = seal(
      await this.keyring(),
      accessToken,
      accessTokenAad(this.provider, itemId),
    );

    return {
      provider: this.provider,
      externalItemId: itemId,
      institutionId,
      // A link with no institution is a Same-Day micro-deposit Item. It still syncs; it just has
      // no name to show, and "Bank account" beats an empty header.
      institutionName: institution?.name ?? 'Bank account',
      institutionLogo: institution?.logo ?? null,
      accessTokenCiphertext: sealed.ciphertext,
      keyId: sealed.keyId,
      consentExpiresAt: consent === null ? null : new Date(consent),
    };
  }

  async syncTransactions(
    connection: AggregatorConnection,
    cursor: string | null,
  ): Promise<SyncPage> {
    const accessToken = await this.openToken(connection);

    const request: TransactionsSyncRequest = {
      access_token: accessToken,
      count: this.pageSize,
      // The bank's own wording is what the descriptor normaliser was built against. Plaid's
      // cleaned `name` has already had the processor prefixes stripped — which is exactly the
      // evidence §6.4's decoder needs to show the user.
      options: { include_original_description: true },
    };
    // Assigned conditionally rather than as `cursor ?? undefined`: `exactOptionalPropertyTypes`
    // distinguishes an absent property from one set to undefined, and Plaid distinguishes them
    // too — an explicit null cursor is not the same request as no cursor.
    if (cursor !== null) request.cursor = cursor;

    const response = await this.call('syncTransactions', () =>
      this.client.transactionsSync(request),
    );

    const currencyByAccount = new Map(
      response.data.accounts.map((account) => [account.account_id, accountCurrency(account)]),
    );
    const map = (row: PlaidTransaction): AggregatorTransaction =>
      mapTransaction(row, currencyByAccount.get(row.account_id) ?? 'USD');

    return {
      added: response.data.added.map(map),
      modified: response.data.modified.map(map),
      removed: response.data.removed.map((row) => row.transaction_id),
      nextCursor: response.data.next_cursor,
      hasMore: response.data.has_more,
    };
  }

  async getAccounts(connection: AggregatorConnection): Promise<readonly AggregatorAccount[]> {
    const accessToken = await this.openToken(connection);
    const response = await this.call('getAccounts', () =>
      this.client.accountsGet({ access_token: accessToken }),
    );
    return response.data.accounts.map((account) => ({
      externalId: account.account_id,
      name: account.name,
      officialName: account.official_name ?? null,
      mask: account.mask ?? null,
      type: account.type,
      subtype: account.subtype,
      currency: accountCurrency(account),
    }));
  }

  async removeConnection(connection: AggregatorConnection): Promise<void> {
    const accessToken = await this.openToken(connection);
    await this.call('removeConnection', () => this.client.itemRemove({ access_token: accessToken }));
  }

  // ── webhooks ─────────────────────────────────────────────────────────────────────────

  async handleWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string | undefined>>,
  ): Promise<WebhookEvent> {
    const jwt = headerValue(headers, 'plaid-verification');
    if (jwt === null) {
      throw new AggregatorError(this.provider, 'invalid_webhook', 'Delivery is not signed.');
    }

    await this.verifySignature(jwt, rawBody);

    const body = parseJsonObject(rawBody, this.provider);
    const type = `${readString(body, 'webhook_type') ?? 'UNKNOWN'}.${
      readString(body, 'webhook_code') ?? 'UNKNOWN'
    }`;

    return {
      provider: this.provider,
      // Derived from the signature, not the body. A Plaid retransmission repeats the same JWT,
      // so it hashes to the same id and the unique index rejects it; a genuinely new delivery
      // carries a fresh `iat` and therefore a fresh signature. Hashing the body alone would
      // conflate two real updates that happened to carry identical payloads.
      externalId: sha256Hex(jwt),
      itemExternalId: readString(body, 'item_id'),
      type,
      kind: webhookKindOf(readString(body, 'webhook_type'), readString(body, 'webhook_code')),
      payload: body,
    };
  }

  private async verifySignature(jwt: string, rawBody: string): Promise<void> {
    const parts = jwt.split('.');
    const [headerPart, payloadPart, signaturePart] = parts;
    if (parts.length !== 3 || headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
      throw new AggregatorError(this.provider, 'invalid_webhook', 'Malformed verification header.');
    }

    const header = parseJsonObject(decodeBase64Url(headerPart), this.provider);
    if (readString(header, 'alg') !== 'ES256') {
      // Plaid only ever signs ES256. Accepting whatever the header claims is how JWT
      // implementations get talked into `alg: none`.
      throw new AggregatorError(this.provider, 'invalid_webhook', 'Unexpected signing algorithm.');
    }
    const kid = readString(header, 'kid');
    if (kid === null) {
      throw new AggregatorError(this.provider, 'invalid_webhook', 'Verification header has no kid.');
    }

    const keyResponse = await this.call('webhookVerificationKeyGet', () =>
      this.client.webhookVerificationKeyGet({ key_id: kid }),
    );
    const key = keyResponse.data.key;
    if (key.expired_at !== null) {
      throw new AggregatorError(this.provider, 'invalid_webhook', 'Signing key has been retired.');
    }

    const publicKey = createPublicKey({
      key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
      format: 'jwk',
    });
    // A JWS ES256 signature is raw r‖s, not the DER sequence OpenSSL defaults to.
    const verified = createVerify('SHA256')
      .update(`${headerPart}.${payloadPart}`)
      .verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signaturePart, 'base64url'));
    if (!verified) {
      throw new AggregatorError(this.provider, 'invalid_webhook', 'Signature does not verify.');
    }

    const claims = parseJsonObject(decodeBase64Url(payloadPart), this.provider);

    const issuedAt = readNumber(claims, 'iat');
    if (issuedAt === null) {
      throw new AggregatorError(this.provider, 'invalid_webhook', 'Signed payload has no iat.');
    }
    const ageSeconds = Math.abs(this.clock.epochMillis() / 1000 - issuedAt);
    if (ageSeconds > this.webhookMaxAgeSeconds) {
      throw new AggregatorError(this.provider, 'invalid_webhook', 'Delivery is outside the replay window.', {
        ageSeconds: Math.round(ageSeconds),
      });
    }

    const expectedDigest = readString(claims, 'request_body_sha256');
    if (expectedDigest === null || !safeEqual(expectedDigest, sha256Hex(rawBody))) {
      // Without this the signature proves only that *some* body was signed by Plaid at some
      // point — a captured header replayed over an attacker's payload would pass.
      throw new AggregatorError(this.provider, 'invalid_webhook', 'Body does not match its signature.');
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────────────

  private async keyring(): Promise<Keyring> {
    return this.injectedKeyring ?? (await getKeyring());
  }

  /**
   * Opens the sealed access token.
   *
   * The one place in the process where a bank credential exists in plaintext, and it exists for
   * the duration of one API call.
   */
  private async openToken(connection: AggregatorConnection): Promise<string> {
    try {
      return open(
        await this.keyring(),
        { keyId: connection.keyId, ciphertext: connection.accessTokenCiphertext },
        accessTokenAad(connection.provider, connection.externalItemId),
      );
    } catch (cause) {
      // The message from @ledger/crypto is safe (it names the key id, never the material), but
      // it is restated rather than forwarded so that this path cannot start leaking if that
      // message ever changes.
      throw new AggregatorError(
        this.provider,
        'not_configured',
        'The stored access token could not be opened. The encryption key may have been rotated out.',
        { connectionId: connection.id, keyId: connection.keyId, reason: describeCause(cause) },
      );
    }
  }

  private async fetchInstitution(
    institutionId: string,
  ): Promise<{ name: string; logo: string | null } | null> {
    try {
      const response = await this.client.institutionsGetById({
        institution_id: institutionId,
        country_codes: [...this.countryCodes],
        options: { include_optional_metadata: true },
      });
      return {
        name: response.data.institution.name,
        logo: response.data.institution.logo ?? null,
      };
    } catch (cause) {
      // A missing display name must not cost the user their connection: the Item already exists
      // upstream at this point, and throwing here would strand it with no local row.
      void cause;
      return null;
    }
  }

  /**
   * Runs one upstream call and converts any failure into a sanitised `AggregatorError`.
   *
   * Note that `cause` is not forwarded. See the file header.
   */
  private async call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      throw this.sanitize(operation, cause);
    }
  }

  private sanitize(operation: string, cause: unknown): AggregatorError {
    const plaid = readPlaidError(cause);
    const code = mapPlaidErrorCode(plaid.errorCode);
    return new AggregatorError(
      this.provider,
      code,
      plaid.errorMessage ?? `Plaid rejected ${operation}.`,
      {
        operation,
        plaidErrorCode: plaid.errorCode,
        plaidErrorType: plaid.errorType,
        requestId: plaid.requestId,
      },
    );
  }
}

// ── mapping ────────────────────────────────────────────────────────────────────────────

interface CurrencyBearing {
  readonly balances: { readonly iso_currency_code: string | null; readonly unofficial_currency_code: string | null };
}

function accountCurrency(account: CurrencyBearing): string {
  return (
    account.balances.iso_currency_code ?? account.balances.unofficial_currency_code ?? 'USD'
  ).toUpperCase();
}

/**
 * One Plaid transaction into the neutral DTO.
 *
 * `original_description` is preferred over `name` because it is what the bank actually printed;
 * `name` is Plaid's cleaned version, and normalising an already-normalised string loses the
 * processor prefixes the descriptor decoder exists to explain. It is only present when
 * `include_original_description` was requested, hence the fallback.
 */
export function mapTransaction(row: PlaidTransaction, fallbackCurrency: string): AggregatorTransaction {
  const code = (row.iso_currency_code ?? row.unofficial_currency_code ?? fallbackCurrency).toUpperCase();

  return {
    externalId: row.transaction_id,
    accountExternalId: row.account_id,
    postedAt: parsePlainDate(row.date),
    authorizedAt: row.authorized_date === null ? null : parsePlainDate(row.authorized_date),
    amountMinor: toOutflowMinor(minorUnitsFromDecimal(row.amount, code), 'positive-outflow'),
    currency: code,
    rawDescriptor: row.original_description ?? row.name,
    pending: row.pending,
    // An allow-list, not the payload. Everything here is either shown to the user or used to
    // debug a bad match; nothing here is identity data.
    raw: {
      merchantName: row.merchant_name ?? null,
      merchantId: row.merchant_entity_id ?? null,
      paymentChannel: row.payment_channel,
      pendingTransactionId: row.pending_transaction_id,
      category: row.personal_finance_category?.primary ?? null,
      logoUrl: row.logo_url ?? null,
      website: row.website ?? null,
    },
  };
}

/**
 * Plaid's webhook taxonomy reduced to what the product does about it.
 *
 * `PENDING_EXPIRATION` is the one that matters most: it is Plaid telling us consent lapses in
 * seven days, and it is the difference between warning a user before their connection breaks and
 * apologising after (brief §7).
 */
export function webhookKindOf(webhookType: string | null, webhookCode: string | null): WebhookKind {
  if (webhookType !== 'ITEM' && webhookType !== 'TRANSACTIONS') return 'other';
  switch (webhookCode) {
    case 'SYNC_UPDATES_AVAILABLE':
    case 'DEFAULT_UPDATE':
    case 'INITIAL_UPDATE':
      return 'sync_updates';
    case 'HISTORICAL_UPDATE':
      return 'historical_ready';
    case 'ERROR':
    case 'LOGIN_REPAIRED':
    case 'USER_PERMISSION_REVOKED':
    case 'PENDING_DISCONNECT':
      return webhookCode === 'ERROR' ? 'error' : 'reauth_required';
    case 'PENDING_EXPIRATION':
      return 'consent_expiring';
    case 'USER_ACCOUNT_REVOKED':
      return 'item_removed';
    case 'NEW_ACCOUNTS_AVAILABLE':
    case null:
    default:
      return 'other';
  }
}

export function mapPlaidErrorCode(errorCode: string | null): AggregatorErrorCode {
  switch (errorCode) {
    case 'ITEM_LOGIN_REQUIRED':
    case 'ITEM_LOCKED':
    case 'USER_PERMISSION_REVOKED':
    case 'USER_INPUT_TIMEOUT':
      return 'reauth_required';
    case 'ACCESS_NOT_GRANTED':
    case 'ITEM_CONCURRENTLY_DELETED':
      return 'consent_expired';
    case 'ITEM_NOT_FOUND':
    case 'INVALID_ACCESS_TOKEN':
      return 'item_not_found';
    case 'RATE_LIMIT':
    case 'RATE_LIMIT_EXCEEDED':
      return 'rate_limited';
    case 'INSTITUTION_DOWN':
    case 'INSTITUTION_NOT_RESPONDING':
    case 'INTERNAL_SERVER_ERROR':
    case 'PLANNED_MAINTENANCE':
    case 'PRODUCT_NOT_READY':
      return 'temporarily_unavailable';
    case 'INVALID_API_KEYS':
    case 'INVALID_CREDENTIALS':
      return 'not_configured';
    case null:
    default:
      return 'upstream';
  }
}

// ── unknown-shape readers ──────────────────────────────────────────────────────────────

interface PlaidErrorFields {
  readonly errorCode: string | null;
  readonly errorType: string | null;
  readonly errorMessage: string | null;
  readonly requestId: string | null;
}

/**
 * Digs the four safe fields out of an axios error without touching anything else.
 *
 * Written against `unknown` rather than axios's types on purpose: the point of this function is
 * that it cannot accidentally read `config`, and a structural walk makes that visible.
 */
function readPlaidError(cause: unknown): PlaidErrorFields {
  const response = readRecord(readRecord(asRecord(cause), 'response'), 'data');
  if (response === null) {
    return { errorCode: null, errorType: null, errorMessage: describeCause(cause), requestId: null };
  }
  return {
    errorCode: readString(response, 'error_code'),
    errorType: readString(response, 'error_type'),
    errorMessage: readString(response, 'error_message'),
    requestId: readString(response, 'request_id'),
  };
}

/**
 * A one-line description of a thrown value, with no object graph attached.
 *
 * `String(error)` on an axios error yields "AxiosError: Request failed with status code 400" —
 * safe. It never serialises `config`.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return 'Unknown upstream failure.';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readRecord(source: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return source === null ? null : asRecord(source[key]);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseJsonObject(text: string, provider: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    void cause;
    throw new AggregatorError(provider, 'invalid_webhook', 'Delivery body is not JSON.');
  }
  const record = asRecord(parsed);
  if (record === null) {
    throw new AggregatorError(provider, 'invalid_webhook', 'Delivery body is not a JSON object.');
  }
  return record;
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function headerValue(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | null {
  // Node lowercases incoming header names, but a framework in front of us may not have, and a
  // signature check that silently does not run is worse than one that fails.
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value !== undefined && value !== '') return value;
  }
  return null;
}

function toCountryCode(value: string): CountryCode {
  const upper = value.toUpperCase();
  // Widened to `string[]` before the lookup: comparing a plain string against an enum member is
  // exactly the kind of accidental-any this codebase bans, and the values are their own names.
  const supported: readonly string[] = Object.values(CountryCode);
  if (!supported.includes(upper)) {
    throw new AggregatorError(PLAID_PROVIDER, 'not_configured', `Unsupported country code: ${value}`);
  }
  return upper as CountryCode;
}

function buildClient(options: PlaidAdapterOptions): PlaidClient {
  const clientId = options.clientId;
  const secret = options.secret;
  if (clientId === undefined || clientId === '' || secret === undefined || secret === '') {
    throw new AggregatorError(
      PLAID_PROVIDER,
      'not_configured',
      'AGGREGATOR=plaid requires PLAID_CLIENT_ID and PLAID_SECRET. Use AGGREGATOR=fixture for local development.',
    );
  }

  const environment = options.environment ?? 'sandbox';
  const basePath = PlaidEnvironments[environment];
  if (basePath === undefined) {
    throw new AggregatorError(PLAID_PROVIDER, 'not_configured', `Unknown Plaid environment: ${environment}`);
  }

  return new PlaidApi(
    new Configuration({
      basePath,
      baseOptions: {
        headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret, 'Plaid-Version': '2020-09-14' },
      },
    }),
  );
}
