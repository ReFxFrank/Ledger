/**
 * `pnpm providers:audit` — which playbooks have gone stale.
 *
 * This is a report, not a gate: it always exits 0. A stale playbook is not a build error, it
 * is a maintenance task, and failing the build on the passage of time trains people to ignore
 * the check. `providers:validate` is the gate.
 *
 * Usage: providers:audit [dir] [--today=YYYY-MM-DD] [--days=N]
 */

import process from 'node:process';
import {
  SystemClock,
  describeError,
  formatPlainDate,
  parsePlainDate,
  today as todayOn,
  type PlainDate,
} from '@ledger/core';
import { STALE_AFTER_DAYS, auditPlaybooks } from '../audit';
import { MERCHANT_DATA_DIR, loadMerchants } from '../load';

function flag(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

function main(): void {
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const dir = positional ?? MERCHANT_DATA_DIR;

  const todayFlag = flag('today');
  const today: PlainDate =
    todayFlag === null ? todayOn(new SystemClock()) : parsePlainDate(todayFlag);
  const daysFlag = flag('days');
  const thresholdDays = daysFlag === null ? STALE_AFTER_DAYS : Number(daysFlag);
  if (!Number.isInteger(thresholdDays) || thresholdDays < 0) {
    throw new Error(`--days must be a non-negative integer, got ${String(daysFlag)}`);
  }

  const merchants = loadMerchants(dir);
  const report = auditPlaybooks(merchants, { today, thresholdDays });

  console.log(
    `Playbook verification audit — ${formatPlainDate(report.today)}, ` +
      `threshold ${String(report.thresholdDays)} days\n`,
  );

  if (report.stale.length === 0) {
    console.log('  No stale playbooks.');
  } else {
    for (const entry of report.stale) {
      const age = `${String(entry.daysSinceVerified)}d`.padStart(6);
      const who = `${entry.slug} / ${entry.channel}`.padEnd(36);
      console.log(`  ${age}  ${who}  verified ${entry.lastVerifiedAt}  ${entry.sourceUrl}`);
    }
  }

  if (report.futureDated.length > 0) {
    console.log('\n  Verified in the future (check the year):');
    for (const entry of report.futureDated) {
      console.log(`          ${entry.slug} / ${entry.channel}  ${entry.lastVerifiedAt}`);
    }
  }

  console.log(
    `\n${String(report.stale.length)} of ${String(report.totalPlaybooks)} playbook(s) need re-verifying.`,
  );
}

try {
  main();
  process.exitCode = 0;
} catch (error) {
  // A broken dataset is validate's problem to report; here it just means no audit was possible.
  console.error(`providers:audit could not run: ${describeError(error).message}`);
  process.exitCode = 0;
}
