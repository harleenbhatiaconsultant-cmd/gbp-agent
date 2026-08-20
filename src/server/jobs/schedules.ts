/**
 * Recurring job registration.
 *
 * Runs in the scheduler process only, which must be pinned to ONE replica: two
 * schedulers would each fire the same schedules and every job would run twice.
 *
 * Each schedule enqueues a fan-out job rather than the work itself. The fan-out
 * enumerates subjects and enqueues one deterministically-keyed job each, so the
 * set of schedules stays fixed no matter how many customers exist.
 *
 * Registration is idempotent: BullMQ's job schedulers are upserted by id, so
 * restarting updates the existing entry rather than accumulating duplicates,
 * and changing a cron pattern takes effect rather than leaving the old one
 * running alongside. Schedulers whose definition has been deleted entirely are
 * removed on startup.
 */

import { getQueue } from '@/server/jobs/queues';
import { QUEUE, type JobName, type QueueName } from '@/server/jobs/types';
import { logger } from '@/server/observability/logger';

export interface ScheduleDefinition {
  /** Also the scheduler id, so upserting is idempotent. */
  jobName: JobName;
  queue: QueueName;
  /** Standard 5-field cron, interpreted in UTC. */
  pattern: string;
  description: string;
}

/**
 * Times are staggered rather than all at midnight: the maintenance sweep should
 * have flagged a dead connection before the sync tries to use it, and audits
 * should run after the data they audit has been refreshed.
 */
export const SCHEDULES: readonly ScheduleDefinition[] = [
  {
    jobName: 'maintenance.tokenRefreshSweep',
    queue: QUEUE.MAINTENANCE,
    pattern: '15 * * * *',
    description: 'Hourly: refresh every active connection to catch revoked access early',
  },
  {
    jobName: 'maintenance.reapStaleJobs',
    queue: QUEUE.MAINTENANCE,
    pattern: '45 * * * *',
    description: 'Hourly: mark job runs abandoned by a dead worker as failed',
  },
  {
    jobName: 'sync.fanout',
    queue: QUEUE.SYNC,
    pattern: '0 2 * * *',
    description: 'Daily 02:00 UTC: sync every active connection from Google',
  },
  {
    jobName: 'audit.fanout',
    queue: QUEUE.AUDIT,
    pattern: '0 4 * * 1',
    description: 'Weekly Monday 04:00 UTC: audit every location, after the nightly sync',
  },
  {
    jobName: 'maintenance.snapshotPrune',
    queue: QUEUE.MAINTENANCE,
    pattern: '30 3 * * 0',
    description: 'Weekly Sunday 03:30 UTC: prune superseded snapshots',
  },
];

export interface RegisterResult {
  registered: number;
  removed: number;
  skipped: boolean;
}

export async function registerSchedules(): Promise<RegisterResult> {
  const wantedIds = new Set(SCHEDULES.map((s) => s.jobName));
  let registered = 0;
  let removed = 0;

  for (const queueName of new Set(SCHEDULES.map((s) => s.queue))) {
    const queue = getQueue(queueName);
    if (!queue) {
      logger.warn('Queueing unavailable; no schedules registered');
      return { registered: 0, removed: 0, skipped: true };
    }

    // Drop schedulers whose definition no longer exists. Upsert handles pattern
    // changes, but a deleted definition would otherwise keep firing forever.
    const existing = await queue.getJobSchedulers();
    for (const scheduler of existing) {
      if (!wantedIds.has(scheduler.key as JobName)) {
        await queue.removeJobScheduler(scheduler.key);
        removed += 1;
        logger.info(
          { schedulerId: scheduler.key, pattern: scheduler.pattern },
          'Removed obsolete schedule',
        );
      }
    }

    for (const schedule of SCHEDULES.filter((s) => s.queue === queueName)) {
      await queue.upsertJobScheduler(
        schedule.jobName,
        { pattern: schedule.pattern, tz: 'UTC' },
        {
          name: schedule.jobName,
          data: {},
          opts: {
            // A fan-out that overruns should not pile up behind itself.
            removeOnComplete: { age: 24 * 3600, count: 50 },
            removeOnFail: { age: 7 * 24 * 3600, count: 100 },
          },
        },
      );
      registered += 1;
      logger.info(
        { jobName: schedule.jobName, pattern: schedule.pattern },
        schedule.description,
      );
    }
  }

  return { registered, removed, skipped: false };
}

/** Currently registered schedules, for the ops view. */
export async function listRegisteredSchedules(): Promise<
  Array<{ id: string; name: string; pattern: string | null; next: Date | null }>
> {
  const results: Array<{ id: string; name: string; pattern: string | null; next: Date | null }> = [];

  for (const queueName of new Set(SCHEDULES.map((s) => s.queue))) {
    const queue = getQueue(queueName);
    if (!queue) continue;

    const schedulers = await queue.getJobSchedulers().catch(() => []);
    for (const scheduler of schedulers) {
      results.push({
        id: scheduler.key,
        name: scheduler.name,
        pattern: scheduler.pattern ?? null,
        next: scheduler.next ? new Date(scheduler.next) : null,
      });
    }
  }

  return results.sort((a, b) => (a.next?.getTime() ?? 0) - (b.next?.getTime() ?? 0));
}

/** Static description of the schedule, readable without Redis. */
export function describeSchedules(): readonly ScheduleDefinition[] {
  return SCHEDULES;
}
