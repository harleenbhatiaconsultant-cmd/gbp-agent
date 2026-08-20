/**
 * Read model for the background-jobs ops view.
 *
 * Answers "did the nightly sync actually run, and what broke" from Postgres
 * rather than from log grep. JobRun is the durable record; Redis retains only a
 * short live window, so queue depth is best-effort and job history is not.
 */

import { JobStatus } from '@/generated/prisma/enums';
import { requireCapability } from '@/server/auth/rbac';
import type { TenantContext } from '@/server/auth/tenant-context';
import { isQueueingAvailable } from '@/server/jobs/redis';
import { getQueueStats } from '@/server/jobs/queues';
import { describeSchedules, listRegisteredSchedules } from '@/server/jobs/schedules';
import { logger } from '@/server/observability/logger';

export interface JobRunRow {
  id: string;
  queue: string;
  jobName: string;
  status: JobStatus;
  attempts: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  error: string | null;
}

export interface JobsView {
  queueingConfigured: boolean;
  queues: Array<{ queue: string; waiting: number; active: number; delayed: number; failed: number }>;
  schedules: Array<{
    name: string;
    pattern: string;
    description: string;
    next: Date | null;
    registered: boolean;
  }>;
  recentRuns: JobRunRow[];
  failedLast24h: number;
}

export async function getJobsView(ctx: TenantContext): Promise<JobsView> {
  requireCapability(ctx, 'organization:view');

  const configured = isQueueingAvailable();

  // Queue depths and live schedules need Redis; the rest does not. Failing the
  // whole page because Redis is unreachable would hide the JobRun history,
  // which is exactly what someone debugging an outage came here to read.
  const [queues, registered] = configured
    ? await Promise.all([
        getQueueStats().catch((error) => {
          logger.error({ err: error }, 'Could not read queue stats');
          return [];
        }),
        listRegisteredSchedules().catch((error) => {
          logger.error({ err: error }, 'Could not read registered schedules');
          return [];
        }),
      ])
    : [[], []];

  const registeredById = new Map(registered.map((s) => [s.id, s]));

  const schedules = describeSchedules().map((schedule) => {
    const live = registeredById.get(schedule.jobName);
    return {
      name: schedule.jobName,
      pattern: schedule.pattern,
      description: schedule.description,
      next: live?.next ?? null,
      registered: Boolean(live),
    };
  });

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [runs, failedLast24h] = await Promise.all([
    ctx.db.jobRun.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        queue: true,
        jobName: true,
        status: true,
        attempts: true,
        startedAt: true,
        finishedAt: true,
        error: true,
      },
    }),
    ctx.db.jobRun.count({
      where: {
        organizationId: ctx.organizationId,
        status: JobStatus.FAILED,
        createdAt: { gte: since },
      },
    }),
  ]);

  return {
    queueingConfigured: configured,
    queues,
    schedules,
    failedLast24h,
    recentRuns: runs.map((run) => ({
      ...run,
      durationMs:
        run.startedAt && run.finishedAt
          ? run.finishedAt.getTime() - run.startedAt.getTime()
          : null,
    })),
  };
}
