/**
 * The merchant registry the detection engine sees.
 *
 * Built from the `merchants` **table**, not from the YAML in `@ledger/providers`. That is not an
 * arbitrary choice: `MerchantRegistryEntry.id` is written straight onto `detections.merchant_id`,
 * which is a foreign key to `merchants.id`, so an entry whose id is a YAML slug produces a
 * detection row that cannot be inserted. The YAML is the source; the table is the identity.
 *
 * `@ledger/providers` is still the loader for playbooks — the cancellation flow in `apps/web`
 * uses it — but nothing in this worker resolves a playbook, so it is not a dependency here.
 *
 * The cache exists because the dataset is refreshed by a separate job and a worker that read the
 * table once at boot would keep matching against last month's merchants until someone restarted
 * it. Fifteen minutes is short enough that a dataset update lands within a sync cycle and long
 * enough that a busy queue is not re-reading a few hundred rows per job.
 */

import { isNull } from 'drizzle-orm';
import { type Category, type RecurrenceInterval, type Clock, interval } from '@ledger/core';
import { type Database, merchants } from '@ledger/db';
import { type MerchantRegistry, createInMemoryRegistry } from '@ledger/detection';
import { childLogger } from '@ledger/logger';

const log = childLogger('worker.registry');

export const REGISTRY_TTL_MS = 15 * 60 * 1000;

interface MerchantRow {
  readonly id: string;
  readonly name: string;
  readonly aliases: string[];
  readonly descriptorPatterns: string[];
  readonly typicalIntervals: { unit: 'day' | 'week' | 'month' | 'year'; count: number }[];
  readonly category: Category;
}

function toEntries(rows: readonly MerchantRow[]): {
  id: string;
  name: string;
  aliases: readonly string[];
  descriptorPatterns: readonly string[];
  typicalIntervals: readonly RecurrenceInterval[];
  category: Category;
}[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    aliases: row.aliases,
    descriptorPatterns: row.descriptorPatterns,
    typicalIntervals: row.typicalIntervals.map((value) => interval(value.unit, value.count)),
    category: row.category,
  }));
}

export async function loadMerchantRegistry(db: Database): Promise<MerchantRegistry> {
  const rows = await db
    .select({
      id: merchants.id,
      name: merchants.name,
      aliases: merchants.aliases,
      descriptorPatterns: merchants.descriptorPatterns,
      typicalIntervals: merchants.typicalIntervals,
      category: merchants.category,
    })
    .from(merchants)
    // A superseded merchant still resolves through the row that replaced it; registering both
    // would let an old descriptor match the dead one first and stamp a merchant id nothing links
    // to any more.
    .where(isNull(merchants.supersededBy));

  return createInMemoryRegistry(toEntries(rows));
}

/**
 * A registry that reloads itself occasionally.
 *
 * Returns null rather than throwing when the table cannot be read: `detectSubscriptions` is
 * documented to work without a registry, and a sync that refuses to run because a reference
 * table was briefly unavailable is a worse outcome than a sync with weaker merchant matching.
 */
export class MerchantRegistryCache {
  private cached: MerchantRegistry | null = null;
  private loadedAtMillis = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<MerchantRegistry> | null = null;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly ttlMs: number = REGISTRY_TTL_MS,
  ) {}

  async get(): Promise<MerchantRegistry | null> {
    if (this.cached !== null && this.clock.epochMillis() - this.loadedAtMillis < this.ttlMs) {
      return this.cached;
    }
    // One reload at a time: without this, four sync jobs starting together after a TTL expiry
    // would each issue the same query.
    this.inFlight ??= loadMerchantRegistry(this.db);

    try {
      const registry = await this.inFlight;
      this.cached = registry;
      this.loadedAtMillis = this.clock.epochMillis();
      return registry;
    } catch (error) {
      log.error(
        { reason: error instanceof Error ? error.message : 'unknown' },
        'merchant registry reload failed — detection continues with the previous copy',
      );
      return this.cached;
    } finally {
      this.inFlight = null;
    }
  }
}
