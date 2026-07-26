/**
 * Reading the merchant dataset off disk.
 *
 * Two audiences, one code path: the app calls `loadMerchants()` and wants a hard failure if
 * anything is wrong, while `providers:validate` calls `validateMerchantDir()` and wants the
 * complete list of what is wrong. Reporting only the first bad file would mean one CI round
 * trip per typo, so every error in the dataset is collected before anything throws.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LedgerError, describeError, isIntermediated, type BillingChannel } from '@ledger/core';
import { parse as parseYaml } from 'yaml';
import {
  merchantFileSchema,
  normalizeAliasKey,
  normalizeDescriptorKey,
  type MerchantFile,
  type Playbook,
} from './schema';
import type { z } from 'zod';

export const MERCHANT_DATA_DIR = fileURLToPath(new URL('../data/merchants', import.meta.url));

/**
 * Files whose name starts with `_` are scaffolding (`_TEMPLATE.yaml`). They are validated —
 * an invalid template propagates into every file copied from it — but never registered as a
 * merchant.
 */
function isTemplateFile(path: string): boolean {
  return basename(path).startsWith('_');
}

export class MerchantDatasetError extends LedgerError {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[]) {
    super('CONFIGURATION_ERROR', message, { meta: { problemCount: problems.length } });
    this.name = 'MerchantDatasetError';
    this.problems = problems;
  }
}

export interface MerchantFileResult {
  /** Absolute path, for tooling that needs to open the file. */
  readonly filePath: string;
  /** Path relative to the data directory, posix-separated, for messages. */
  readonly displayPath: string;
  readonly isTemplate: boolean;
  /** Null when the file failed to parse or validate. */
  readonly merchant: MerchantFile | null;
  readonly errors: readonly string[];
}

export interface DatasetValidation {
  readonly dir: string;
  readonly files: readonly MerchantFileResult[];
  /** Problems no single file can see: duplicate slugs, colliding patterns, dangling links. */
  readonly crossFileErrors: readonly string[];
  readonly ok: boolean;
}

// ── reading ────────────────────────────────────────────────────────────────────────────

function compareNames(a: string, b: string): number {
  // Not localeCompare: error output has to be byte-identical across machines and locales.
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function yamlFilesIn(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => compareNames(a.name, b.name));

  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...yamlFilesIn(full));
    } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      found.push(full);
    }
  }
  return found;
}

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}

function readOne(filePath: string, dir: string): MerchantFileResult {
  const displayPath = relative(dir, filePath).split(sep).join('/');
  const base = { filePath, displayPath, isTemplate: isTemplateFile(filePath) };

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { ...base, merchant: null, errors: [`unreadable YAML: ${describeError(error).message}`] };
  }

  if (raw === null || raw === undefined) {
    return { ...base, merchant: null, errors: ['file is empty'] };
  }

  const result = merchantFileSchema.safeParse(raw);
  if (!result.success) {
    return { ...base, merchant: null, errors: result.error.issues.map(formatIssue) };
  }
  return { ...base, merchant: result.data, errors: [] };
}

// ── cross-file rules ───────────────────────────────────────────────────────────────────

interface RegisteredMerchant {
  readonly merchant: MerchantFile;
  /** Where it came from, for error messages. Empty when the caller built the list in memory. */
  readonly origin: string;
}

function findCrossFileErrors(entries: readonly RegisteredMerchant[]): string[] {
  const errors: string[] = [];
  const bySlug = new Map<string, RegisteredMerchant>();
  const byPattern = new Map<string, RegisteredMerchant>();
  const byAlias = new Map<string, RegisteredMerchant>();

  const describe = (entry: RegisteredMerchant): string =>
    entry.origin === '' ? entry.merchant.slug : `${entry.merchant.slug} (${entry.origin})`;

  for (const entry of entries) {
    const existing = bySlug.get(entry.merchant.slug);
    if (existing !== undefined) {
      errors.push(`duplicate slug "${entry.merchant.slug}": ${describe(existing)} and ${describe(entry)}`);
      continue;
    }
    bySlug.set(entry.merchant.slug, entry);
  }

  for (const entry of entries) {
    for (const pattern of entry.merchant.descriptorPatterns) {
      const key = normalizeDescriptorKey(pattern);
      const owner = byPattern.get(key);
      // Two merchants claiming one fragment makes detection's answer depend on file order.
      if (owner !== undefined && owner.merchant.slug !== entry.merchant.slug) {
        errors.push(
          `descriptor fragment "${key}" is claimed by both ${describe(owner)} and ${describe(entry)}`,
        );
        continue;
      }
      byPattern.set(key, entry);
    }

    for (const alias of aliasKeysOf(entry.merchant)) {
      const owner = byAlias.get(alias);
      if (owner !== undefined && owner.merchant.slug !== entry.merchant.slug) {
        errors.push(`alias "${alias}" is claimed by both ${describe(owner)} and ${describe(entry)}`);
        continue;
      }
      byAlias.set(alias, entry);
    }

    const supersededBy = entry.merchant.supersededBy;
    if (supersededBy !== undefined && !entries.some((e) => e.merchant.slug === supersededBy)) {
      errors.push(`${describe(entry)} is supersededBy "${supersededBy}", which is not in the dataset`);
    }
  }

  return errors;
}

/** The slug is a free alias — it is unique by construction and is what URLs use. */
function aliasKeysOf(merchant: MerchantFile): string[] {
  return [merchant.slug, ...merchant.aliases].map(normalizeAliasKey);
}

// ── public API ─────────────────────────────────────────────────────────────────────────

export function validateMerchantDir(dir: string = MERCHANT_DATA_DIR): DatasetValidation {
  if (!existsSync(dir)) {
    throw new MerchantDatasetError(`Merchant data directory not found: ${dir}`, []);
  }

  const files = yamlFilesIn(dir).map((filePath) => readOne(filePath, dir));
  const registrable = files.flatMap<RegisteredMerchant>((file) =>
    file.isTemplate || file.merchant === null
      ? []
      : [{ merchant: file.merchant, origin: file.displayPath }],
  );

  const crossFileErrors = findCrossFileErrors(registrable);
  const ok = crossFileErrors.length === 0 && files.every((file) => file.errors.length === 0);
  return { dir, files, crossFileErrors, ok };
}

/**
 * Every valid merchant in the dataset, or a throw listing *all* problems at once.
 * Template files are excluded from the result but not from validation.
 */
export function loadMerchants(dir: string = MERCHANT_DATA_DIR): MerchantFile[] {
  const validation = validateMerchantDir(dir);
  if (!validation.ok) {
    const problems = [
      ...validation.files.flatMap((file) =>
        file.errors.map((error) => `${file.displayPath} → ${error}`),
      ),
      ...validation.crossFileErrors,
    ];
    throw new MerchantDatasetError(
      `${String(problems.length)} problem(s) in the merchant dataset at ${dir}:\n  ${problems.join('\n  ')}`,
      problems,
    );
  }

  const merchants: MerchantFile[] = [];
  for (const file of validation.files) {
    if (file.isTemplate || file.merchant === null) continue;
    merchants.push(file.merchant);
  }
  return merchants;
}

// ── registry ───────────────────────────────────────────────────────────────────────────

/**
 * The lookup surface `packages/detection` consumes. Detection owns the equivalent declaration
 * in its own `src/types.ts` and must not import this package (it has to stay dependency-free),
 * so the two are kept structurally compatible by hand. Keys are normalized on the way in, so
 * callers may pass raw descriptor text.
 */
export interface MerchantRegistry {
  byExactPattern(key: string): MerchantFile | null;
  byAlias(key: string): MerchantFile | null;
  bySlug(slug: string): MerchantFile | null;
  all(): MerchantFile[];
}

export function buildRegistry(merchants: readonly MerchantFile[]): MerchantRegistry {
  const entries = merchants.map<RegisteredMerchant>((merchant) => ({ merchant, origin: '' }));
  const conflicts = findCrossFileErrors(entries);
  if (conflicts.length > 0) {
    throw new MerchantDatasetError(
      `Cannot build the merchant registry:\n  ${conflicts.join('\n  ')}`,
      conflicts,
    );
  }

  const patterns = new Map<string, MerchantFile>();
  const aliases = new Map<string, MerchantFile>();
  const slugs = new Map<string, MerchantFile>();

  for (const merchant of merchants) {
    slugs.set(merchant.slug, merchant);
    for (const pattern of merchant.descriptorPatterns) {
      patterns.set(normalizeDescriptorKey(pattern), merchant);
    }
    for (const alias of aliasKeysOf(merchant)) {
      aliases.set(alias, merchant);
    }
  }

  const snapshot = [...merchants];
  return {
    byExactPattern: (key) => patterns.get(normalizeDescriptorKey(key)) ?? null,
    byAlias: (key) => aliases.get(normalizeAliasKey(key)) ?? null,
    bySlug: (slug) => slugs.get(slug) ?? null,
    all: () => [...snapshot],
  };
}

// ── routing ────────────────────────────────────────────────────────────────────────────

/**
 * The playbook to show for a subscription billed through `channel`.
 *
 * Falling back to the `direct` playbook is fine for PayPal or an unknown channel — the
 * provider's own cancel flow is still the right advice there. It is **never** fine for
 * Apple/Google/Amazon/Roku/Microsoft/carrier: the provider's website cannot cancel those, and
 * showing its cancel button to someone billed by the App Store is how this product loses a
 * user their money. When there is no store playbook we return null and the UI says so.
 */
export function findPlaybook(merchant: MerchantFile, channel: BillingChannel): Playbook | null {
  const exact = merchant.playbooks.find((playbook) => playbook.channel === channel);
  if (exact !== undefined) return exact;
  if (isIntermediated(channel)) return null;
  return merchant.playbooks.find((playbook) => playbook.channel === 'direct') ?? null;
}
