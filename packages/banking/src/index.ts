/**
 * @ledger/banking — the aggregator seam and the sync engine.
 *
 * The public surface is the adapter contract, the two adapters, the sync engine, the webhook
 * intake, and connection health. Everything above this package (the tRPC routers, the worker)
 * talks to `AggregatorAdapter` and `SyncStore` and never to Plaid.
 *
 * Three things this package will never do, restated here because this is the file where someone
 * would be tempted to add them:
 *
 *  1. It does not log into a third party as the user. There is no credential store, no headless
 *     browser, no "automated cancellation" behind a flag. Ledger reads a bank feed the user has
 *     consented to share.
 *  2. It does not store raw bank credentials. Aggregator access tokens are sealed by
 *     `@ledger/crypto` before they leave `exchangeToken`, and the plaintext exists only inside
 *     an adapter, for the duration of one call.
 *  3. It makes no legal claims. The strings in `health.ts` describe what will happen to a
 *     connection, never what anyone is required to do.
 */

export {
  type AggregatorAccount,
  type AggregatorAdapter,
  type AggregatorConnection,
  type AggregatorErrorCode,
  type AggregatorTransaction,
  type AmountSignConvention,
  type LinkSession,
  type LinkSessionOptions,
  type LinkedItem,
  type SyncPage,
  type WebhookEvent,
  type WebhookKind,
  AGGREGATOR_ERROR_CODES,
  AggregatorError,
  LEDGER_SIGN_CONVENTION,
  REAUTH_ERROR_CODES,
  RETRYABLE_ERROR_CODES,
  WEBHOOK_KINDS,
  accessTokenAad,
  isAggregatorError,
  isRetryable,
  minorUnitsFromDecimal,
  toOutflowMinor,
} from './adapter';

export {
  type PlaidAdapterOptions,
  type PlaidClient,
  PLAID_PROVIDER,
  PlaidAdapter,
  mapPlaidErrorCode,
  mapTransaction,
  webhookKindOf,
} from './plaid-adapter';

export {
  type FixtureAdapterOptions,
  FIXTURE_PROVIDER,
  FIXTURE_WINDOW_MONTHS,
  FixtureAdapter,
  buildCorpus,
} from './fixture-adapter';

export {
  type CommitPageInput,
  type CommitPageResult,
  type ConnectionFailure,
  type DetectionPlan,
  type DetectionSummary,
  type DetectionWrite,
  type DetectionWriteResult,
  type FinishSyncInput,
  type PagePlan,
  type StoredAccount,
  type StoredConnection,
  type StoredDetection,
  type SubscriptionLink,
  type SyncContext,
  type SyncOptions,
  type SyncResult,
  type SyncStore,
  type SyncTarget,
  type TransactionWrite,
  BACKFILL_MONTHS,
  DEFAULT_MAX_PAGES,
  dedupeHashFor,
  detectionKey,
  planDetections,
  planPage,
  planSubscriptionLinks,
  preservedDetectionStatus,
  reconcileDetections,
  syncConnection,
  toDetectionTransaction,
} from './sync';

export { DrizzleSyncStore } from './store';

export {
  type MemoryConnectionSeed,
  type MemoryTransaction,
  type PageHook,
  MemorySyncStore,
} from './memory-store';

export {
  type RecordOutcome,
  type WebhookContext,
  type WebhookDelivery,
  type WebhookOutcome,
  type WebhookReceipt,
  type WebhookStore,
  receiveWebhook,
  shouldSyncFor,
} from './webhooks';

export {
  type ConnectionHealth,
  type ConnectionHealthInput,
  CONSENT_WARNING_DAYS,
  STALE_SYNC_DAYS,
  connectionsNeedingConsentWarning,
  deriveConnectionHealth,
} from './health';

export { type AdapterEnv, selectAdapter } from './select-adapter';
