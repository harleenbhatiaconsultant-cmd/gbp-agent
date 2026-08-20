/**
 * Queue handles and enqueueing.
 *
 * Every enqueue goes through `enqueue()` so that job ids, retry policy and
 * result retention are applied consistently, and so a caller cannot bypass
 * deduplication by constructing a Queue directly.
 *
 * When Redis is absent every enqueue is a logged no-op rather than a throw.
 * The alternative — failing a user's request because a background nicety could
 * not be scheduled — is worse than the work simply not happening yet.
 */

import { Queue, type JobsOptions } from 'bullmq';
import { env } from '@/config/env.server';
import { getRedisConnection, isQueueingAvailable } from '@/server/jobs/redis';
import { logger } from '@/server/observability/logger';
import {
  ALL_QUEUES,
  JOB_QUEUE,
  QUEUE_RETRY,
  type AnyJob,
  type JobName,
  type QueueName,
} from '@/server/jobs/types';

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  const existing = queues.get(name);
  if (existing) return existing;

  const queue = new Queue(name, {
    connection,
    prefix: env.QUEUE_PREFIX,
    defaultJobOptions: {
      // Keep a bounded history in Redis. JobRun rows in Postgres are the
      // durable record; Redis only needs enough for live inspection.
      removeOnComplete: { age: 24 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
    },
  });

  queue.on('error', (error) => {
    logger.error({ err: error, queue: name }, 'Queue error');
  });

  queues.set(name, queue);
  return queue;
}

export interface EnqueueOptions {
  /** Deterministic id. Re-enqueueing the same id is a no-op in BullMQ. */
  jobId?: string;
  delayMs?: number;
  priority?: number;
}

export interface EnqueueResult {
  enqueued: boolean;
  jobId?: string;
  reason?: string;
}

/**
 * Enqueues a job.
 *
 * Returns `{ enqueued: false }` rather than throwing when queueing is
 * unavailable, so callers can report "scheduled" vs "not scheduled" honestly
 * instead of pretending the work is queued.
 */
export async function enqueue<T extends AnyJob>(
  job: T,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const queueName = JOB_QUEUE[job.name];
  const queue = getQueue(queueName);

  if (!queue) {
    logger.debug(
      { jobName: job.name },
      'Queueing unavailable; job not enqueued (REDIS_URL is unset)',
    );
    return { enqueued: false, reason: 'Queueing is not configured (REDIS_URL is unset).' };
  }

  const retry = QUEUE_RETRY[queueName];
  const jobOptions: JobsOptions = {
    jobId: options.jobId,
    delay: options.delayMs,
    priority: options.priority,
    attempts: retry.attempts,
    backoff: { type: 'exponential', delay: retry.backoffMs },
  };

  try {
    const added = await queue.add(job.name, job.data, jobOptions);
    logger.debug({ jobName: job.name, jobId: added.id, queue: queueName }, 'Job enqueued');
    return { enqueued: true, jobId: added.id ?? undefined };
  } catch (error) {
    logger.error({ err: error, jobName: job.name }, 'Failed to enqueue job');
    return {
      enqueued: false,
      reason: error instanceof Error ? error.message : 'Enqueue failed',
    };
  }
}

/** Live queue depths, for the ops view. */
export async function getQueueStats(): Promise<
  Array<{ queue: QueueName; waiting: number; active: number; delayed: number; failed: number }>
> {
  if (!isQueueingAvailable()) return [];

  const stats = [];
  for (const name of ALL_QUEUES) {
    const queue = getQueue(name);
    if (!queue) continue;
    try {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      stats.push({
        queue: name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      });
    } catch (error) {
      logger.error({ err: error, queue: name }, 'Failed to read queue counts');
    }
  }
  return stats;
}

export async function closeQueues(): Promise<void> {
  for (const [name, queue] of queues) {
    try {
      await queue.close();
    } catch (error) {
      logger.error({ err: error, queue: name }, 'Error closing queue');
    }
  }
  queues.clear();
}

export type { JobName };
