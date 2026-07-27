/**
 * The worker process.
 *
 * Boots one of everything — a Postgres pool, a Redis connection, an aggregator adapter, a set of
 * notification channels — registers a `Worker` per queue, installs the repeatables, and then does
 * nothing until a job or a signal arrives.
 *
 * The part worth reading is the shutdown.
 *
 * A worker killed mid-sync is *safe*: the sync cursor is written in the same Postgres transaction
 * as the page it describes, so a restart resumes from the last committed page and replays at most
 * one page against `ON CONFLICT DO NOTHING`. Safe is not the same as free, though — a killed
 * backfill throws away up to a page of aggregator round trips and the user waits longer for their
 * dashboard. So SIGTERM does not abort anything:
 *
 *   1. Health flips to `draining`, so the container stops being reported ready.
 *   2. Every worker is closed *gracefully* — BullMQ stops fetching new jobs and resolves once the
 *      in-flight ones have finished.
 *   3. Queues and Redis connections close.
 *   4. The database pool closes last, because step 2 is still using it.
 *
 * A hard deadline sits over all of it. If a job wedges, the process exits anyway rather than
 * hanging until the orchestrator's SIGKILL — `stop_grace_period` in the compose file is 60s and
 * `WORKER_SHUTDOWN_TIMEOUT_MS` defaults to 45s so this side always wins the race and gets to
 * close the pool itself. A second signal skips the wait entirely, because the second Ctrl-C
 * always means "I meant it".
 */

import { type Job, type Processor, Worker } from 'bullmq';
import type { DatabaseHandle } from '@ledger/db';
import { closeDatabase } from '@ledger/db';

import { type WorkerContext, createWorkerContext } from './context';
import { HealthState, createHealthServer } from './health';
import {
  type QueueKey,
  type QueuePayloads,
  QUEUE_NAMES,
  closeQueues,
  registerRepeatables,
} from './queues';
import { runScheduler } from './jobs/scheduler';
import { runSender } from './jobs/sender';
import { runSync, enqueueScheduledSyncs } from './jobs/sync';
import { runVerifyCancellations } from './jobs/verify-cancellation';
import { runFollowUps } from './jobs/follow-up';
import { runRetention } from './jobs/retention';

/**
 * What the shutdown path needs from a worker, and nothing else.
 *
 * `Worker<T>` is invariant in its data type, so a heterogeneous array of them has no useful
 * common supertype. Rather than widen with a cast, each worker is fully typed where it is
 * constructed — including its event handlers — and only this much of it escapes.
 */
interface ManagedWorker {
  readonly name: string;
  close(force?: boolean): Promise<void>;
}

function buildWorkers(ctx: WorkerContext): ManagedWorker[] {
  const connection = { url: ctx.config.redisUrl };
  const { sync, sender, maintenance } = ctx.config.concurrency;
  const log = ctx.log;

  const make = <K extends QueueKey>(
    key: K,
    concurrency: number,
    processor: Processor<QueuePayloads[K], void>,
  ): ManagedWorker => {
    const worker = new Worker<QueuePayloads[K], void, string>(QUEUE_NAMES[key], processor, {
      connection,
      concurrency,
    });

    worker.on('failed', (job, error) => {
      log.error(
        { queue: worker.name, jobId: job?.id, attempts: job?.attemptsMade ?? 0 },
        error.message,
      );
    });
    // A stalled job means the previous run of it was lost — a hard kill, or a job that blocked
    // the event loop past the lock duration. Worth a line, because it is the symptom of both.
    worker.on('stalled', (jobId) => {
      log.warn({ queue: worker.name, jobId }, 'job stalled and will be retried');
    });

    return worker;
  };

  return [
    make('sync', sync, async (job: Job<QueuePayloads['sync']>) => {
      await runSync(ctx, job.data);
    }),
    make('scheduler', maintenance, async () => {
      await runScheduler(ctx);
      // Folded into the same hourly tick rather than given its own queue: enqueueing a sync per
      // connection is a handful of Redis writes, and a separate repeatable would be a second
      // thing to notice had stopped.
      await enqueueScheduledSyncs(ctx);
    }),
    make('sender', sender, async () => {
      await runSender(ctx);
    }),
    make('verifyCancellation', maintenance, async () => {
      await runVerifyCancellations(ctx);
    }),
    make('followUp', maintenance, async () => {
      await runFollowUps(ctx);
    }),
    make('retention', maintenance, async () => {
      await runRetention(ctx);
    }),
  ];
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const health = new HealthState(startedAt);

  const { context: ctx, handle } = await createWorkerContext();
  const log = ctx.log;

  const healthServer = createHealthServer({
    port: ctx.config.healthPort,
    host: ctx.config.healthHost,
    state: health,
    clock: ctx.clock,
  });
  await healthServer.listen();

  await registerRepeatables(ctx.queues);
  const workers = buildWorkers(ctx);

  health.set('ready');
  log.info(
    {
      queues: workers.map((worker) => worker.name),
      healthPort: ctx.config.healthPort,
      aggregator: ctx.adapter.provider,
      merchants: (await ctx.registry.get())?.all().length ?? 0,
    },
    'worker ready',
  );

  installSignalHandlers(ctx, health, workers, handle, () => healthServer.close());
}

type Closer = () => Promise<void>;

function installSignalHandlers(
  ctx: WorkerContext,
  health: HealthState,
  workers: readonly ManagedWorker[],
  handle: DatabaseHandle,
  closeHealthServer: Closer,
): void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      // The second signal is not a retry, it is an instruction. Exit without waiting.
      ctx.log.warn({ signal }, 'second signal received — exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;
    health.set('draining');
    ctx.log.info({ signal }, 'draining: no new jobs will be started');

    void drain(ctx, health, workers, handle, closeHealthServer).then(
      () => {
        process.exit(0);
      },
      (error: unknown) => {
        ctx.log.error(
          { reason: error instanceof Error ? error.message : 'unknown' },
          'shutdown did not complete cleanly',
        );
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function drain(
  ctx: WorkerContext,
  health: HealthState,
  workers: readonly ManagedWorker[],
  handle: DatabaseHandle,
  closeHealthServer: Closer,
): Promise<void> {
  const deadline = new Promise<'timeout'>((resolve) => {
    const timer = setTimeout(() => {
      resolve('timeout');
    }, ctx.config.shutdownTimeoutMs);
    // Nothing else should be keeping the process alive by then, and an unreffed timer means the
    // deadline never becomes the reason the process stays up.
    timer.unref();
  });

  // `close()` without `force` is the graceful one: it stops fetching and waits for active jobs.
  const graceful = Promise.all(workers.map((worker) => worker.close())).then(() => 'done' as const);

  const outcome = await Promise.race([graceful, deadline]);
  if (outcome === 'timeout') {
    ctx.log.warn(
      { timeoutMs: ctx.config.shutdownTimeoutMs },
      'in-flight jobs did not finish in time — forcing close (an interrupted sync resumes from its cursor)',
    );
    await Promise.all(workers.map((worker) => worker.close(true)));
  }

  await closeQueues(ctx.queues);
  await closeHealthServer();
  // Last, because everything above it was still issuing queries.
  await handle.close();
  await closeDatabase();
  health.set('stopped');
  ctx.log.info('shutdown complete');
}

main().catch((error: unknown) => {
  // Nothing is up yet, so there is no logger to be sure of. `pino` is already configured by the
  // time `createWorkerContext` resolves; before that, a hard exit with a readable reason is all
  // that is available and all that is useful.
  process.stderr.write(
    `worker failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
