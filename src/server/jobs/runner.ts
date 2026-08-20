/**
 * JobRun recording.
 *
 * Every job execution is written to Postgres before and after it runs, so the
 * ops view answers "did the nightly sync actually happen, and what broke" from
 * the database rather than from log grep. Redis retains only a short window;
 * this is the durable record.
 *
 * Recording failures never fail the job. A job that succeeded but could not be
 * logged is still a job that succeeded, and losing the work to preserve the
 * bookkeeping would be the wrong trade.
 */

import type { Prisma } from '@/generated/prisma/client';
import { JobStatus } from '@/generated/prisma/enums';
import { prisma } from '@/server/db';
import { childLogger } from '@/server/observability/logger';
import type { JobName, QueueName } from '@/server/jobs/types';

export interface JobRunMeta {
  queue: QueueName;
  jobName: JobName;
  /** BullMQ job id, so a Postgres row can be traced back to the Redis job. */
  jobId?: string;
  organizationId?: string | null;
  attempt: number;
  payload?: Prisma.InputJsonValue;
}

export interface JobOutcome<T> {
  result: T;
  /** Short human summary stored on the JobRun for the ops view. */
  summary?: string;
}

/**
 * Runs a handler with JobRun bookkeeping around it.
 *
 * Rethrows on failure so BullMQ applies its retry policy — swallowing the error
 * here would make a job look successful while its work never happened.
 */
export async function withJobRun<T>(
  meta: JobRunMeta,
  handler: () => Promise<JobOutcome<T>>,
): Promise<T> {
  const log = childLogger({
    queue: meta.queue,
    jobName: meta.jobName,
    jobId: meta.jobId,
    organizationId: meta.organizationId ?? undefined,
    attempt: meta.attempt,
  });

  const startedAt = new Date();

  const runRecord = await prisma.jobRun
    .create({
      data: {
        organizationId: meta.organizationId ?? null,
        queue: meta.queue,
        jobName: meta.jobName,
        jobId: meta.jobId ?? null,
        status: JobStatus.RUNNING,
        attempts: meta.attempt,
        payload: meta.payload,
        startedAt,
      },
      select: { id: true },
    })
    .catch((error) => {
      log.error({ err: error }, 'Could not record JobRun start');
      return null;
    });

  try {
    const { result, summary } = await handler();

    if (runRecord) {
      await prisma.jobRun
        .update({
          where: { id: runRecord.id },
          data: {
            status: JobStatus.COMPLETED,
            finishedAt: new Date(),
            error: summary ?? null,
          },
        })
        .catch((error) => log.error({ err: error }, 'Could not record JobRun completion'));
    }

    log.info({ durationMs: Date.now() - startedAt.getTime(), summary }, 'Job completed');
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown job failure';

    if (runRecord) {
      await prisma.jobRun
        .update({
          where: { id: runRecord.id },
          data: {
            status: JobStatus.FAILED,
            finishedAt: new Date(),
            error: message.slice(0, 2000),
          },
        })
        .catch((updateError) =>
          log.error({ err: updateError }, 'Could not record JobRun failure'),
        );
    }

    log.error({ err: error, durationMs: Date.now() - startedAt.getTime() }, 'Job failed');
    throw error;
  }
}

/**
 * Marks jobs that were RUNNING when a worker died.
 *
 * Without this they stay RUNNING forever and the ops view slowly fills with
 * phantom in-flight work.
 */
export async function reapStaleJobRuns(olderThanMinutes = 60): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);

  const { count } = await prisma.jobRun.updateMany({
    where: { status: JobStatus.RUNNING, startedAt: { lt: cutoff } },
    data: {
      status: JobStatus.FAILED,
      finishedAt: new Date(),
      error: 'Marked failed by the reaper: the worker stopped without reporting an outcome.',
    },
  });

  return count;
}
