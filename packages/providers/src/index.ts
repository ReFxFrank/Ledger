/**
 * @ledger/providers — the merchant registry and the cancellation playbooks behind it.
 *
 * The dataset itself is YAML under `data/merchants/`; everything exported here is either the
 * schema those files must satisfy, the loader that turns them into a registry, or the audit
 * that stops them rotting silently. The CLIs under `src/cli/` are not part of the public API.
 */

export {
  LEGAL_CLAIM_PATTERN,
  findLegalClaim,
  merchantFileSchema,
  normalizeAliasKey,
  normalizeDescriptorKey,
  playbookSchema,
  type MerchantFile,
  type Playbook,
  type PlaybookStep,
} from './schema';

export {
  MERCHANT_DATA_DIR,
  MerchantDatasetError,
  buildRegistry,
  findPlaybook,
  loadMerchants,
  validateMerchantDir,
  type DatasetValidation,
  type MerchantFileResult,
  type MerchantRegistry,
} from './load';

export {
  STALE_AFTER_DAYS,
  auditPlaybooks,
  type AuditOptions,
  type PlaybookAuditEntry,
  type PlaybookAuditReport,
} from './audit';
