/**
 * Staleness reporting for the playbook dataset.
 *
 * A cancellation playbook is a claim about someone else's website, and websites change without
 * telling us. The risk register calls this out: the failure mode is not "the dataset is
 * missing something", it is "the dataset confidently walks a user through a flow that no
 * longer exists". `lastVerifiedAt` is mandatory in the schema; this is the report that makes
 * an unverified one visible.
 *
 * Pure: `today` is passed in so the report is testable on a fixed clock.
 */

import { daysBetween, parsePlainDate, type BillingChannel, type PlainDate } from '@ledger/core';
import type { MerchantFile } from './schema';

/** Brief §3.2 / risk register. Anything older than this is treated as unknown, not as fact. */
export const STALE_AFTER_DAYS = 180;

export interface PlaybookAuditEntry {
  readonly slug: string;
  readonly name: string;
  readonly channel: BillingChannel;
  readonly lastVerifiedAt: string;
  /** Negative when the file claims a verification date in the future. */
  readonly daysSinceVerified: number;
  readonly sourceUrl: string;
}

export interface PlaybookAuditReport {
  readonly today: PlainDate;
  readonly thresholdDays: number;
  readonly totalPlaybooks: number;
  /** Older than the threshold, oldest first. */
  readonly stale: readonly PlaybookAuditEntry[];
  /** Verified "in the future" — a typo in the year, and it would never go stale. */
  readonly futureDated: readonly PlaybookAuditEntry[];
}

export interface AuditOptions {
  readonly today: PlainDate;
  readonly thresholdDays?: number;
}

export function auditPlaybooks(
  merchants: readonly MerchantFile[],
  options: AuditOptions,
): PlaybookAuditReport {
  const thresholdDays = options.thresholdDays ?? STALE_AFTER_DAYS;
  const entries: PlaybookAuditEntry[] = [];

  for (const merchant of merchants) {
    for (const playbook of merchant.playbooks) {
      entries.push({
        slug: merchant.slug,
        name: merchant.name,
        channel: playbook.channel,
        lastVerifiedAt: playbook.lastVerifiedAt,
        // The schema has already guaranteed this parses.
        daysSinceVerified: daysBetween(parsePlainDate(playbook.lastVerifiedAt), options.today),
        sourceUrl: playbook.sourceUrl,
      });
    }
  }

  const stale = entries
    .filter((entry) => entry.daysSinceVerified > thresholdDays)
    .sort((a, b) => b.daysSinceVerified - a.daysSinceVerified);

  return {
    today: options.today,
    thresholdDays,
    totalPlaybooks: entries.length,
    stale,
    futureDated: entries.filter((entry) => entry.daysSinceVerified < 0),
  };
}
