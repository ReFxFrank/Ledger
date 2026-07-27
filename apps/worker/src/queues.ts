/**
 * Queue definitions.
 *
 * Three decisions live here, and each of them is the answer to a specific way a job queue rots.
 *
 * **Bounded retention.** `removeOnComplete` and `removeOnFail` are counts *and* ages. Left at
 * BullMQ's default, completed jobs accumulate in Redis forever, and the first symptom is not a
 * slow queue — it is a Redis instance that has quietly eaten its maxmemory and started evicting
 * the keys the queue itself needs.
 *
 * **Exponential backoff.** A bank that is down is down for minutes, not milliseconds. Linear
 * retries against a rate-limiting aggregator are how a transient failure becomes a ban.
 *
 * **Idempotent job ids where it matters.** `sync` is the one queue that gets enqueued from the
 * outside — a webhook, a user pressing "refresh", a re-enqueue for the next page — and all three
 * can happen within a second of each other for one connection. `bucketedJobId` collapses them:
 * two enqueues for the same connection inside the same short bucket are the same job id, and
 * BullMQ drops the second. The bucket is derived from an injected clock rather than `Date.now()`
 * so the collapse window is a tested property rather than a hope.
 */

import { type ConnectionOptions, type DefaultJobOptions, Queue } from 'bullmq';
import type { Clock } from '@ledger/core';

export const QUEUE_NAMES = {
  sync: 'ledger:sync',
  scheduler: 'ledger:scheduler',
  sender: 'ledger:sender',
  verifyCancellation: 'ledger:verify-cancellation',
  followUp: 'ledger:follow-up',
  retention: 'ledger:retention',
} as const;

export type QueueKey = keyof typeof QUEUE_NAMES;
export type QueueName = (typeof QUEUE_NAMES)[QueueKey];

export const QUEUE_KEYS = Object.keys(QUEUE_NAMES) as readonly QueueKey[];

// ── job payloads ───────────────────────────────────────────────────────────────────────

export type SyncReason = 'webhook' | 'manual' | 'scheduled' | 'continuation';

export interface SyncJobData {
  readonly userId: string;
  readonly connectionId: string;
  readonly reason: SyncReason;
}

/**
 * What a repeatable housekeeping job carries.
 *
 * `trigger` exists so a run kicked off by hand during an incident is distinguishable in the logs
 * from the hourly tick that was going to happen anyway.
 */
export interface TickJobData {
  readonly trigger: 'repeat' | 'manual';
}

export interface QueuePayloads {
  readonly sync: SyncJobData;
  readonly scheduler: TickJobData;
  readonly sender: TickJobData;
  readonly verifyCancellation: TickJobData;
  readonly followUp: TickJobData;
  readonly retention: TickJobData;
}

// ── defaults ───────────────────────────────────────────────────────────────────────────

export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  // A day of successes is enough to answer "did the 03:00 purge run?"; anything older is
  // answered from the logs.
  removeOnComplete: { count: 500, age: 24 * 60 * 60 },
  // Failures are kept far longer and in greater number — they are the ones somebody reads.
  removeOnFail: { count: 5_000, age: 7 * 24 * 60 * 60 },
};

/**
 * Per-queue overrides.
 *
 * The sender gets fewer attempts because it already tracks `notifications.attempts` per row: the
 * job retrying is not the mechanism that retries a notification, and stacking the two produces
 * `attempts × job attempts` deliveries of anything that half-fails.
 */
export const QUEUE_JOB_OPTIONS: Readonly<Record<QueueKey, DefaultJobOptions>> = {
  sync: { ...DEFAULT_JOB_OPTIONS, attempts: 5, backoff: { type: 'exponential', delay: 60_000 } },
  scheduler: { ...DEFAULT_JOB_OPTIONS, attempts: 3 },
  sender: { ...DEFAULT_JOB_OPTIONS, attempts: 2 },
  verifyCancellation: { ...DEFAULT_JOB_OPTIONS, attempts: 3 },
  followUp: { ...DEFAULT_JOB_OPTIONS, attempts: 3 },
  retention: { ...DEFAULT_JOB_OPTIONS, attempts: 2 },
};

// ── idempotent job ids ─────────────────────────────────────────────────────────────────

/** The window inside which repeat enqueues for one subject collapse into a single job. */
export const SYNC_JOB_BUCKET_MS = 5 * 60 * 1000;

/**
 * A job id that is stable for one subject within one time bucket.
 *
 * Not a bare `sync:<connectionId>`: BullMQ refuses to re-add a job id that is still retained in
 * the completed set, so a permanently stable id would mean a connection could be synced once and
 * then never again until the retention window rolled over. The bucket is the compromise —
 * duplicate enqueues collapse, and the next bucket is a genuinely new job.
 */
export function bucketedJobId(
  kind: string,
  subject: string,
  clock: Clock,
  bucketMs: number = SYNC_JOB_BUCKET_MS,
): string {
  const bucket = Math.floor(clock.epochMillis() / bucketMs);
  return `${kind}:${subject}:${String(bucket)}`;
}

export function syncJobId(connectionId: string, clock: Clock): string {
  return bucketedJobId('sync', connectionId, clock);
}

// ── repeatables ────────────────────────────────────────────────────────────────────────

export interface RepeatableDefinition {
  /**
   * Never `sync`. That queue is driven by events — a webhook, a manual refresh, the hourly tick
   * enqueueing one job per connection — and a repeatable on it would have no connection to sync.
   * Excluding it in the type is also what lets `registerRepeatables` be written without a cast.
   */
  readonly queue: Exclude<QueueKey, 'sync'>;
  /** Stable across deploys — `upsertJobScheduler` keys on it, so changing it orphans the old one. */
  readonly schedulerId: string;
  readonly jobName: string;
  /** A cron pattern in UTC. `every` is deliberately not used except for the sender. */
  readonly pattern?: string;
  readonly everyMs?: number;
}

/**
 * The schedule.
 *
 * The minute offsets are not decoration. The scheduler materialises rows and the sender drains
 * them; the verifier and the follow-up job both write notifications of their own. Running them
 * all on the hour would have four jobs contending for the same rows every hour, so each gets its
 * own slot.
 */
export const REPEATABLE_JOBS: readonly RepeatableDefinition[] = [
  { queue: 'scheduler', schedulerId: 'scheduler-hourly', jobName: 'materialize', pattern: '0 * * * *' },
  { queue: 'sender', schedulerId: 'sender-minute', jobName: 'drain', everyMs: 60_000 },
  {
    queue: 'verifyCancellation',
    schedulerId: 'verify-cancellation-hourly',
    jobName: 'verify',
    pattern: '20 * * * *',
  },
  { queue: 'followUp', schedulerId: 'follow-up-daily', jobName: 'nudge', pattern: '40 9 * * *' },
  // 03:10, not 03:00 — the scheduler runs on the hour, every hour, and a table-wide delete
  // contending with the hourly materialisation is the one collision that would actually hurt.
  { queue: 'retention', schedulerId: 'retention-daily', jobName: 'purge', pattern: '10 3 * * *' },
];

// ── construction ───────────────────────────────────────────────────────────────────────

export type Queues = { readonly [K in QueueKey]: Queue<QueuePayloads[K]> };

export function createQueues(connection: ConnectionOptions): Queues {
  const build = <K extends QueueKey>(key: K): Queue<QueuePayloads[K]> =>
    new Queue<QueuePayloads[K]>(QUEUE_NAMES[key], {
      connection,
      defaultJobOptions: QUEUE_JOB_OPTIONS[key],
    });

  return {
    sync: build('sync'),
    scheduler: build('scheduler'),
    sender: build('sender'),
    verifyCancellation: build('verifyCancellation'),
    followUp: build('followUp'),
    retention: build('retention'),
  };
}

/**
 * Installs (or updates) every repeatable.
 *
 * `upsertJobScheduler` rather than `add` with `repeat`: the scheduler id is the identity, so
 * redeploying with a changed cron replaces the schedule instead of leaving a second one behind
 * firing on the old pattern. That failure mode — two schedulers, one invisible — is why the ids
 * above are constants rather than derived strings.
 */
export async function registerRepeatables(queues: Queues): Promise<void> {
  for (const definition of REPEATABLE_JOBS) {
    const queue: Queue<TickJobData> = queues[definition.queue];
    const repeat =
      definition.pattern === undefined
        ? { every: definition.everyMs ?? 60_000 }
        : { pattern: definition.pattern, tz: 'UTC' };

    await queue.upsertJobScheduler(definition.schedulerId, repeat, {
      name: definition.jobName,
      data: { trigger: 'repeat' },
    });
  }
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all(QUEUE_KEYS.map((key) => queues[key].close()));
}
