/**
 * Worker configuration.
 *
 * Everything shared with the web process comes from `@ledger/env`, which has already refused to
 * boot if it is wrong. What is added here is the handful of knobs only this process has: how many
 * jobs it will run at once, what port the health endpoint listens on, and how long it is willing
 * to wait for in-flight work during a shutdown.
 *
 * The parsing is a pure function over a plain env object rather than a read of `process.env`, so
 * the bounds ("concurrency of 0 is a stopped worker, not a configuration") are testable.
 */

import type { ServerEnv } from '@ledger/env';

export interface WorkerConcurrency {
  /** One connection's sync holds a Postgres transaction per page. A few, not dozens. */
  readonly sync: number;
  /** Outbound notification deliveries in flight. Bounded so a slow provider cannot fan out. */
  readonly sender: number;
  /** The scheduled housekeeping queues. These are batch jobs; one at a time is correct. */
  readonly maintenance: number;
}

export interface WorkerConfig {
  readonly redisUrl: string;
  readonly appUrl: string;
  readonly healthPort: number;
  readonly healthHost: string;
  readonly retentionMonths: number;
  readonly concurrency: WorkerConcurrency;
  /**
   * How long `close()` may take before the process exits anyway.
   *
   * Kept under `docker-compose.prod.yml`'s `stop_grace_period` (60s) so the worker always wins
   * the race against SIGKILL and gets to close the pool itself.
   */
  readonly shutdownTimeoutMs: number;
  /** How many due notifications one sender pass claims. Bounds the memory of a backlog drain. */
  readonly senderBatchSize: number;
  /** Attempts a single notification gets before the sender stops picking it up. */
  readonly senderMaxAttempts: number;
}

export const DEFAULT_HEALTH_PORT = 3001;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 45_000;
export const DEFAULT_SENDER_BATCH_SIZE = 100;
export const DEFAULT_SENDER_MAX_ATTEMPTS = 5;

export interface IntBounds {
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}

/**
 * Reads a bounded integer, falling back rather than throwing.
 *
 * A worker that refuses to start because `WORKER_SYNC_CONCURRENCY=four` is a worker that stops
 * syncing over a typo in an operator's shell. The real environment contract is enforced by
 * `@ledger/env`; these are tuning knobs, and a bad knob deserves a default and a log line.
 */
export function readBoundedInt(raw: string | undefined, bounds: IntBounds): number {
  if (raw === undefined || raw.trim() === '') return bounds.fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed)) return bounds.fallback;
  if (parsed < bounds.min) return bounds.min;
  if (parsed > bounds.max) return bounds.max;
  return parsed;
}

export function loadWorkerConfig(
  env: ServerEnv,
  raw: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  return {
    redisUrl: env.REDIS_URL,
    appUrl: env.APP_URL,
    healthPort: readBoundedInt(raw.WORKER_HEALTH_PORT, {
      min: 1,
      max: 65_535,
      fallback: DEFAULT_HEALTH_PORT,
    }),
    // Binds every interface by default because the only consumer is a container healthcheck on
    // an internal network; the port is `expose`d, never published.
    healthHost: raw.WORKER_HEALTH_HOST ?? '0.0.0.0',
    retentionMonths: env.TRANSACTION_RETENTION_MONTHS,
    concurrency: {
      sync: readBoundedInt(raw.WORKER_SYNC_CONCURRENCY, { min: 1, max: 32, fallback: 4 }),
      sender: readBoundedInt(raw.WORKER_SENDER_CONCURRENCY, { min: 1, max: 32, fallback: 4 }),
      maintenance: readBoundedInt(raw.WORKER_MAINTENANCE_CONCURRENCY, {
        min: 1,
        max: 8,
        fallback: 1,
      }),
    },
    shutdownTimeoutMs: readBoundedInt(raw.WORKER_SHUTDOWN_TIMEOUT_MS, {
      min: 1_000,
      max: 300_000,
      fallback: DEFAULT_SHUTDOWN_TIMEOUT_MS,
    }),
    senderBatchSize: readBoundedInt(raw.WORKER_SENDER_BATCH_SIZE, {
      min: 1,
      max: 1_000,
      fallback: DEFAULT_SENDER_BATCH_SIZE,
    }),
    senderMaxAttempts: readBoundedInt(raw.WORKER_SENDER_MAX_ATTEMPTS, {
      min: 1,
      max: 20,
      fallback: DEFAULT_SENDER_MAX_ATTEMPTS,
    }),
  };
}
