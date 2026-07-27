/**
 * Everything the jobs share, built once at boot.
 *
 * Jobs take this as a parameter rather than importing singletons, which is what lets a job's
 * decision logic be tested with a `FixedClock` and no Redis. The context itself is the only place
 * that opens sockets: one Postgres pool, one aggregator adapter, one set of notification
 * channels.
 *
 * Note what is *not* here. There is no provider login, no credential store, no browser. The
 * adapter reads a bank feed the user consented to share, and the only secret this process ever
 * touches is a sealed aggregator token that `@ledger/crypto` opens inside the adapter and nowhere
 * else.
 */

import { type Clock, SystemClock } from '@ledger/core';
import { type AggregatorAdapter, DrizzleSyncStore, selectAdapter } from '@ledger/banking';
import { getKeyring, selectKekProvider } from '@ledger/crypto';
import { type Database, type DatabaseHandle, createDatabase, users } from '@ledger/db';
import { type ServerEnv, loadServerEnv } from '@ledger/env';
import { childLogger, type Logger } from '@ledger/logger';
import {
  type Channel,
  EmailChannel,
  InAppChannel,
  PushChannel,
  type RenderContext,
} from '@ledger/notify';
import { eq } from 'drizzle-orm';

import { type WorkerConfig, loadWorkerConfig } from './config';
import { type Queues, createQueues } from './queues';
import { MerchantRegistryCache } from './registry';
import type { ConnectionOptions } from 'bullmq';

export interface WorkerContext {
  readonly env: ServerEnv;
  readonly config: WorkerConfig;
  readonly clock: Clock;
  readonly db: Database;
  readonly syncStore: DrizzleSyncStore;
  readonly adapter: AggregatorAdapter;
  /** Reloaded on a TTL. Resolves to null only if `merchants` has never been readable. */
  readonly registry: MerchantRegistryCache;
  readonly channels: readonly Channel[];
  readonly queues: Queues;
  readonly log: Logger;
  /** The reader-facing half of rendering. Per-user locale and timezone are merged in at send. */
  readonly renderDefaults: Omit<RenderContext, 'locale' | 'timeZone'>;
}

export interface CreateContextOptions {
  readonly env?: ServerEnv;
  readonly clock?: Clock;
  readonly connection?: ConnectionOptions;
}

export async function createWorkerContext(
  options: CreateContextOptions = {},
): Promise<{ context: WorkerContext; handle: DatabaseHandle }> {
  const env = options.env ?? loadServerEnv();
  const config = loadWorkerConfig(env);
  const clock = options.clock ?? new SystemClock();
  const log = childLogger('worker');

  // A few more connections than the sync concurrency: the sender and the housekeeping jobs also
  // hold one while they run, and a pool that is exactly the job concurrency deadlocks the moment
  // a job wants a second connection for a transaction.
  const handle = createDatabase({ url: env.DATABASE_URL, max: config.concurrency.sync + 6 });
  const db = handle.db;

  const keyring = await getKeyring(selectKekProvider(process.env));
  const adapter = selectAdapter(env, { clock, keyring });

  const queues = createQueues(options.connection ?? { url: config.redisUrl });

  const vapid =
    env.VAPID_PUBLIC_KEY !== undefined && env.VAPID_PRIVATE_KEY !== undefined
      ? {
          subject: env.VAPID_SUBJECT ?? env.APP_URL,
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY,
        }
      : null;

  const channels: readonly Channel[] = [
    new EmailChannel({
      apiKey: env.RESEND_API_KEY ?? null,
      from: env.EMAIL_FROM,
      // Resolved at send time rather than frozen into the JSONB payload, so a user who changes
      // their address is mailed at the new one and an old payload never carries a stale address.
      resolveAddress: async (userId: string) => {
        const rows = await db
          .select({ email: users.email, deletedAt: users.deletedAt })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        const row = rows[0];
        // A deleted account keeps its rows until the cascade job runs. Mailing it in the
        // meantime is the one delivery that cannot be taken back.
        if (row?.deletedAt != null) return null;
        return row?.email ?? null;
      },
      clock,
    }),
    new PushChannel({ db, vapid, clock }),
    new InAppChannel({ db, clock }),
  ];

  const context: WorkerContext = {
    env,
    config,
    clock,
    db,
    syncStore: new DrizzleSyncStore(db),
    adapter,
    registry: new MerchantRegistryCache(db, clock),
    channels,
    queues,
    log,
    renderDefaults: { appUrl: env.APP_URL },
  };

  return { context, handle };
}

