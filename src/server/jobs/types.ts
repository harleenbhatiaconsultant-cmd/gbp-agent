/**
 * Queue and job definitions.
 *
 * Queues are separated by the kind of work they do, not for tidiness: a slow
 * website crawl must not be able to starve review syncing, and a burst of
 * audits must not delay an approved change from being applied. Each queue gets
 * its own concurrency and its own retry policy.
 *
 * Every job payload carries `organizationId` so that a worker can build a
 * tenant-scoped context and nothing runs unscoped.
 */

export const QUEUE = {
  /** Pulling current state from Google. */
  SYNC: 'sync',
  /** Running the audit ruleset against stored snapshots. Pure CPU. */
  AUDIT: 'audit',
  /** Applying approved changes and verifying them. Touches live profiles. */
  EXECUTE: 'execute',
  /** Housekeeping: token refresh sweeps, snapshot pruning, stale job reaping. */
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** Every queue this phase serves. Later phases add ai, rank and report. */
export const ALL_QUEUES: readonly QueueName[] = Object.values(QUEUE);

// ---------------------------------------------------------------------------
// Job payloads
// ---------------------------------------------------------------------------

export interface SyncConnectionJob {
  name: 'sync.connection';
  data: { organizationId: string; connectionId: string };
}

export interface SyncLocationJob {
  name: 'sync.location';
  data: { organizationId: string; locationId: string };
}

/** Enumerates active connections and enqueues one sync job each. */
export interface SyncFanoutJob {
  name: 'sync.fanout';
  data: Record<string, never>;
}

export interface AuditLocationJob {
  name: 'audit.location';
  data: { organizationId: string; locationId: string };
}

export interface AuditFanoutJob {
  name: 'audit.fanout';
  data: Record<string, never>;
}

export interface ExecuteChangeJob {
  name: 'change.execute';
  data: { organizationId: string; changeRequestId: string };
}

export interface VerifyChangeJob {
  name: 'change.verify';
  data: { organizationId: string; changeRequestId: string };
}

export interface TokenRefreshSweepJob {
  name: 'maintenance.tokenRefreshSweep';
  data: Record<string, never>;
}

export interface SnapshotPruneJob {
  name: 'maintenance.snapshotPrune';
  data: Record<string, never>;
}

export interface JobReapJob {
  name: 'maintenance.reapStaleJobs';
  data: Record<string, never>;
}

export type SyncJob = SyncConnectionJob | SyncLocationJob | SyncFanoutJob;
export type AuditJob = AuditLocationJob | AuditFanoutJob;
export type ExecuteJob = ExecuteChangeJob | VerifyChangeJob;
export type MaintenanceJob = TokenRefreshSweepJob | SnapshotPruneJob | JobReapJob;
export type AnyJob = SyncJob | AuditJob | ExecuteJob | MaintenanceJob;

export type JobName = AnyJob['name'];

/** Maps a job name to the queue that serves it. */
export const JOB_QUEUE: Record<JobName, QueueName> = {
  'sync.connection': QUEUE.SYNC,
  'sync.location': QUEUE.SYNC,
  'sync.fanout': QUEUE.SYNC,
  'audit.location': QUEUE.AUDIT,
  'audit.fanout': QUEUE.AUDIT,
  'change.execute': QUEUE.EXECUTE,
  'change.verify': QUEUE.EXECUTE,
  'maintenance.tokenRefreshSweep': QUEUE.MAINTENANCE,
  'maintenance.snapshotPrune': QUEUE.MAINTENANCE,
  'maintenance.reapStaleJobs': QUEUE.MAINTENANCE,
};

/**
 * Per-queue concurrency.
 *
 * EXECUTE is deliberately 1. Applying changes is the only work that mutates a
 * customer profile, it is bounded by Google's ~10 edits/minute per profile
 * anyway, and serialising it makes the ordering of applied changes obvious in
 * the change log rather than interleaved.
 */
export const QUEUE_CONCURRENCY: Record<QueueName, number> = {
  [QUEUE.SYNC]: 3,
  [QUEUE.AUDIT]: 5,
  [QUEUE.EXECUTE]: 1,
  [QUEUE.MAINTENANCE]: 1,
};

/**
 * Retry policy per queue.
 *
 * EXECUTE gets fewer attempts and a longer backoff: a failed write is more
 * likely to be a rejected payload than a blip, and hammering Google with a
 * request it already refused burns the profile's edit quota for no reason.
 */
export const QUEUE_RETRY: Record<QueueName, { attempts: number; backoffMs: number }> = {
  [QUEUE.SYNC]: { attempts: 3, backoffMs: 5_000 },
  [QUEUE.AUDIT]: { attempts: 2, backoffMs: 2_000 },
  [QUEUE.EXECUTE]: { attempts: 2, backoffMs: 30_000 },
  [QUEUE.MAINTENANCE]: { attempts: 2, backoffMs: 10_000 },
};

/**
 * Builds a deterministic job id.
 *
 * BullMQ deduplicates by job id, so a scheduler restart, an overlapping tick or
 * a double-click cannot enqueue the same unit of work twice. The bucket is
 * what scopes that: "this location, this day" is one job no matter how many
 * times it is requested.
 */
export function jobId(name: JobName, subjectId: string, bucket: string): string {
  return `${name}:${subjectId}:${bucket}`;
}

/** Bucket helpers, so callers do not hand-roll date maths inconsistently. */
export const bucket = {
  day(date = new Date()): string {
    return date.toISOString().slice(0, 10);
  },
  hour(date = new Date()): string {
    return date.toISOString().slice(0, 13);
  },
  week(date = new Date()): string {
    const copy = new Date(date);
    // ISO week: shift to the Thursday of the current week.
    copy.setUTCDate(copy.getUTCDate() + 4 - (copy.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((copy.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${copy.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  },
};
