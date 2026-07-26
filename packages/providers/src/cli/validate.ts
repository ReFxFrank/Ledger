/**
 * `pnpm providers:validate` — the CI gate for the merchant dataset.
 *
 * Prints one line per file and every problem underneath it, so a contributor fixes the whole
 * dataset in one pass instead of one error per push. Exits non-zero if anything failed.
 *
 * Usage: providers:validate [dir]
 */

import process from 'node:process';
import { buildRegistry, validateMerchantDir, MERCHANT_DATA_DIR } from '../load';
import { describeError } from '@ledger/core';
import type { MerchantFile } from '../schema';

function main(): number {
  const dir = process.argv[2] ?? MERCHANT_DATA_DIR;
  const validation = validateMerchantDir(dir);

  console.log(`Validating merchant dataset in ${validation.dir}\n`);

  if (validation.files.length === 0) {
    console.log('  (no YAML files found)');
  }

  let failures = 0;
  const merchants: MerchantFile[] = [];

  for (const file of validation.files) {
    const label = file.isTemplate ? `${file.displayPath} [template]` : file.displayPath;

    if (file.errors.length > 0) {
      failures += 1;
      console.log(`  FAIL  ${label}`);
      for (const error of file.errors) console.log(`          ${error}`);
      continue;
    }

    const playbookCount = file.merchant?.playbooks.length ?? 0;
    console.log(`  ok    ${label}  (${String(playbookCount)} playbook(s))`);
    if (!file.isTemplate && file.merchant !== null) merchants.push(file.merchant);
  }

  if (validation.crossFileErrors.length > 0) {
    console.log('\n  Cross-file problems:');
    for (const error of validation.crossFileErrors) console.log(`          ${error}`);
  }

  // The registry is where collisions actually bite, so prove it can be built rather than
  // trusting that the per-file checks were sufficient.
  let registrySize = 0;
  if (validation.ok) {
    try {
      registrySize = buildRegistry(merchants).all().length;
    } catch (error) {
      console.log(`\n  Registry build failed: ${describeError(error).message}`);
      return 1;
    }
  }

  const fileCount = validation.files.length;
  console.log(
    `\n${String(fileCount - failures)}/${String(fileCount)} file(s) valid` +
      (validation.ok ? `, ${String(registrySize)} merchant(s) registered.` : '.'),
  );

  if (!validation.ok) {
    console.log('Dataset is invalid. Nothing ships until every problem above is fixed.');
    return 1;
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`providers:validate failed: ${describeError(error).message}`);
  process.exitCode = 1;
}
