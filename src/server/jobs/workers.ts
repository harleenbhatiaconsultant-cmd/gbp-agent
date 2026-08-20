/**
 * Worker registration.
 *
 * Runs in the standalone worker process, never in `web`. One BullMQ Worker per
 * queue, each with its own concurrency, so a slow sync cannot delay an approved
 * change from being applied.
 *
 * A job name with no handler FAILS rather than being silently acknowledged — an
 * unrecognised job is a deployment mismatch, and quietly dropping it would lose
 * work with no trace.
 */

import { Worker, type Job } from 'bullmq';
import { env } from '@/config/env.server';
import { getRedisConnection } from '@/server/jobs/redis';
import { logger } from '@/server/observability/logger';
import { withJobRun } from '@/server/jobs/runner';
import {
  ALL_QUEUES,
  QUEUE,
  QUEUE_CONCURRENCY,
  type JobName,
  type QueueName,
} from '@/server/jobs/types';
import {
  handleAuditFanout,
  handleAuditLocation,
  handleExecuteChange,
  handleReapStaleJobs,
  handleSnapshotPrune,
  handleSyncConnection,
  handleSyncFanout,
  handleSyncLocation,
  handleTokenRefreshSweep,
  handleVerifyChange,
} from '@/server/jobs/handlers';

const workers: Worker[] = [];

type AnyData = Record<string, string>;

/** Dispatches by job name. Unknown names throw. */
async function dispatch(job: Job): Promise<{ summary?: string }> {
  const data = (job.data ?? {}) as AnyData;

  switch (job.name as JobName) {
    case 'sync.fanout':
      return handleSyncFanout();
    case 'sync.connection':
      return handleSyncConnection({
        organizationId: data.organizationId,
        connectionId: data.connectionId,
      });
    case 'sync.location':
      return handleSyncLocation({
        organizationId: data.organizationId,
        locationId: data.locationId,
      });
    case 'audit.fanout':
      return handleAuditFanout();
    case 'audit.location':
      return handleAuditLocation({
        organizationId: data.organizationId,
        locationId: data.locationId,
      });
    case 'change.execute':
      return handleExecuteChange({
        organizationId: data.organizationId,
        changeRequestId: data.changeRequestId,
      });
    case 'change.verify':
      return handleVerifyChange({
        organizationId: data.organizationId,
        changeRequestId: data.changeRequestId,
      });
    case 'maintenance.tokenRefreshSweep':
      return handleTokenRefreshSweep();
    case 'maintenance.snapshotPrune':
      return handleSnapshotPrune();
    case 'maintenance.reapStaleJobs':
      return handleReapStaleJobs();
    default:
      throw new Error(
        `No handler registered for job "${job.name}". This usually means the worker is running ` +
          'an older build than whatever enqueued it.',
      );
  }
}

function createWorker(queueName: QueueName): Worker | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  const worker = new Worker(
    queueName,
    async (job) =>
      withJobRun(
        {
          queue: queueName,
          jobName: job.name as JobName,
          jobId: job.id,
          organizationId: (job.data as AnyData)?.organizationId ?? null,
          attempt: job.attemptsMade + 1,
          payload: job.data as never,
        },
        async () => {
          const { summary } = await dispatch(job);
          return { result: undefined, summary };
        },
      ),
    {
      connection,
      prefix: env.QUEUE_PREFIX,
      concurrency: Math.min(QUEUE_CONCURRENCY[queueName], env.WORKER_CONCURRENCY),
      // A stalled job is one whose worker died mid-flight. Reclaiming it twice
      // is enough; more usually means something is wrong with the job itself.
      maxStalledCount: 2,
    },
  );

  worker.on('failed', (job, error) => {
    logger.error(
      { err: error, queue: queueName, jobName: job?.name, jobId: job?.id, attempt: job?.attemptsMade },
      'Job failed',
    );
  });

  worker.on('error', (error) => {
    logger.error({ err: error, queue: queueName }, 'Worker error');
  });

  return worker;
}

/** Starts a worker per queue. Returns how many were started. */
export function startWorkers(): number {
  if (workers.length > 0) return workers.length;

  for (const queueName of ALL_QUEUES) {
    const worker = createWorker(queueName);
    if (worker) {
      workers.push(worker);
      logger.info(
        { queue: queueName, concurrency: QUEUE_CONCURRENCY[queueName] },
        'Worker started',
      );
    }
  }

  return workers.length;
}

/**
 * Stops workers, letting in-flight jobs finish.
 *
 * Called before the database closes so a job mid-write is not cut off partway
 * through a transaction.
 */
export async function stopWorkers(): Promise<void> {
  await Promise.all(
    workers.map((worker) =>
      worker
        .close()
        .catch((error) => logger.error({ err: error }, 'Error closing worker')),
    ),
  );
  workers.length = 0;
}

export { QUEUE };
