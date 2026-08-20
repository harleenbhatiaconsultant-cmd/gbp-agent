/**
 * Job layer unit tests.
 *
 * These cover everything that does not need a live Redis: job identity,
 * schedule definitions, the quota governor's in-process path, and the authority
 * boundary for system contexts. The BullMQ round-trip itself is unverifiable
 * until REDIS_URL exists — see the note in the Phase 4 section of the README.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemberRole, PlanTier } from '@/generated/prisma/enums';
import { bucket, jobId, JOB_QUEUE, QUEUE_CONCURRENCY, ALL_QUEUES, QUEUE } from '@/server/jobs/types';
import { SCHEDULES, describeSchedules } from '@/server/jobs/schedules';
import {
  acquireEditSlot,
  acquireRequestSlot,
  resetQuotaForTesting,
} from '@/server/integrations/google/quota';
import { GbpQuotaError } from '@/server/integrations/google/errors';
import { can, requireCapability, systemHasCapability } from '@/server/auth/rbac';
import { createSystemContext } from '@/server/auth/tenant-context';
import { env } from '@/config/env.server';

describe('job identity', () => {
  it('is deterministic for the same subject and bucket', () => {
    const a = jobId('sync.connection', 'conn_1', '2026-08-20');
    const b = jobId('sync.connection', 'conn_1', '2026-08-20');
    expect(a).toBe(b);
  });

  it('differs across subjects and across buckets', () => {
    expect(jobId('sync.connection', 'conn_1', '2026-08-20')).not.toBe(
      jobId('sync.connection', 'conn_2', '2026-08-20'),
    );
    expect(jobId('sync.connection', 'conn_1', '2026-08-20')).not.toBe(
      jobId('sync.connection', 'conn_1', '2026-08-21'),
    );
  });
});

describe('buckets', () => {
  it('produces a stable day key', () => {
    expect(bucket.day(new Date('2026-08-20T23:59:59Z'))).toBe('2026-08-20');
    expect(bucket.day(new Date('2026-08-20T00:00:00Z'))).toBe('2026-08-20');
  });

  it('produces a stable hour key', () => {
    expect(bucket.hour(new Date('2026-08-20T14:59:00Z'))).toBe('2026-08-20T14');
  });

  it('keeps a whole ISO week in one bucket', () => {
    // Monday through Sunday of the same ISO week.
    const monday = bucket.week(new Date('2026-08-17T00:00:00Z'));
    const sunday = bucket.week(new Date('2026-08-23T00:00:00Z'));
    expect(monday).toBe(sunday);
  });

  it('moves to a new bucket in the following week', () => {
    expect(bucket.week(new Date('2026-08-23T00:00:00Z'))).not.toBe(
      bucket.week(new Date('2026-08-24T00:00:00Z')),
    );
  });
});

describe('queue configuration', () => {
  it('routes every job name to a known queue', () => {
    for (const [jobName, queueName] of Object.entries(JOB_QUEUE)) {
      expect(ALL_QUEUES, `${jobName} routes to an unknown queue`).toContain(queueName);
    }
  });

  it('serialises change execution', () => {
    // Applying changes is the only work that mutates a customer profile.
    // Running it one at a time keeps the change log ordering meaningful and
    // stays inside Google's per-profile edit limit.
    expect(QUEUE_CONCURRENCY[QUEUE.EXECUTE]).toBe(1);
  });

  it('gives every queue a positive concurrency', () => {
    for (const queue of ALL_QUEUES) {
      expect(QUEUE_CONCURRENCY[queue]).toBeGreaterThan(0);
    }
  });
});

describe('schedules', () => {
  it('has a unique id per schedule, so upserts stay idempotent', () => {
    const ids = SCHEDULES.map((s) => s.jobName);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses a well-formed five-field cron pattern', () => {
    for (const schedule of SCHEDULES) {
      expect(schedule.pattern.trim().split(/\s+/), schedule.jobName).toHaveLength(5);
    }
  });

  it('routes every scheduled job to a real queue', () => {
    for (const schedule of SCHEDULES) {
      expect(JOB_QUEUE[schedule.jobName]).toBe(schedule.queue);
    }
  });

  it('describes each schedule for the ops view', () => {
    for (const schedule of describeSchedules()) {
      expect(schedule.description.length).toBeGreaterThan(20);
    }
  });

  it('runs the weekly audit after the nightly sync, not before', () => {
    const sync = SCHEDULES.find((s) => s.jobName === 'sync.fanout');
    const audit = SCHEDULES.find((s) => s.jobName === 'audit.fanout');
    const syncHour = Number(sync!.pattern.split(' ')[1]);
    const auditHour = Number(audit!.pattern.split(' ')[1]);
    // Auditing data that has not been refreshed yet would score yesterday's profile.
    expect(auditHour).toBeGreaterThan(syncHour);
  });
});

describe('quota governor (in-process fallback)', () => {
  beforeEach(() => {
    resetQuotaForTesting();
  });

  it('permits requests up to the configured limit', async () => {
    for (let i = 0; i < env.GBP_MAX_QPM; i += 1) {
      await expect(acquireRequestSlot('conn_quota_a')).resolves.toBeUndefined();
    }
  });

  it('refuses the request that would exceed the limit', async () => {
    for (let i = 0; i < env.GBP_MAX_QPM; i += 1) {
      await acquireRequestSlot('conn_quota_b');
    }
    await expect(acquireRequestSlot('conn_quota_b')).rejects.toBeInstanceOf(GbpQuotaError);
  });

  it('keeps one connection budget from exhausting another', async () => {
    for (let i = 0; i < env.GBP_MAX_QPM; i += 1) {
      await acquireRequestSlot('conn_quota_c');
    }
    // A different customer is unaffected.
    await expect(acquireRequestSlot('conn_quota_d')).resolves.toBeUndefined();
  });

  it('enforces the far tighter per-profile edit limit', async () => {
    for (let i = 0; i < env.GBP_MAX_EDITS_PER_MINUTE; i += 1) {
      await acquireEditSlot('locations/quota-1');
    }
    await expect(acquireEditSlot('locations/quota-1')).rejects.toBeInstanceOf(GbpQuotaError);
  });

  it('keeps edit budgets separate per profile', async () => {
    for (let i = 0; i < env.GBP_MAX_EDITS_PER_MINUTE; i += 1) {
      await acquireEditSlot('locations/quota-2');
    }
    await expect(acquireEditSlot('locations/quota-3')).resolves.toBeUndefined();
  });

  it('tells the caller when to retry rather than just failing', async () => {
    for (let i = 0; i < env.GBP_MAX_EDITS_PER_MINUTE; i += 1) {
      await acquireEditSlot('locations/quota-4');
    }
    await acquireEditSlot('locations/quota-4').catch((error: GbpQuotaError) => {
      expect(error.retryAfterMs).toBeGreaterThan(0);
      expect(error.retryable).toBe(true);
    });
  });
});

describe('system context authority', () => {
  const systemCtx = createSystemContext({
    organizationId: 'org_system_test',
    organizationSlug: 'system-test',
    plan: PlanTier.FREE,
  });

  it('may observe and diagnose', () => {
    expect(systemHasCapability('location:sync')).toBe(true);
    expect(systemHasCapability('audit:run')).toBe(true);
    expect(systemHasCapability('location:view')).toBe(true);
    expect(() => requireCapability(systemCtx, 'audit:run')).not.toThrow();
  });

  it('may never authorize anything', () => {
    // A scheduled job carrying its own authority to approve would defeat the
    // entire approval model.
    expect(systemHasCapability('change:approve')).toBe(false);
    expect(systemHasCapability('change:execute')).toBe(false);
    expect(systemHasCapability('change:draft')).toBe(false);
    expect(systemHasCapability('connection:manage')).toBe(false);
    expect(systemHasCapability('members:manage')).toBe(false);
    expect(systemHasCapability('billing:manage')).toBe(false);
  });

  it('throws with an explanation when asked to authorize', () => {
    expect(() => requireCapability(systemCtx, 'change:approve')).toThrowError(
      /observe and diagnose, but never authorize/,
    );
  });

  it('reports capabilities consistently through can()', () => {
    expect(can(systemCtx, 'audit:run')).toBe(true);
    expect(can(systemCtx, 'change:approve')).toBe(false);
  });

  it('does not widen what a human role can do', () => {
    // The system allowlist must not accidentally grant a VIEWER more than their role.
    const viewerCtx = { ...systemCtx, userId: 'u1', role: MemberRole.VIEWER };
    expect(can(viewerCtx, 'location:sync')).toBe(false);
    expect(can(viewerCtx, 'audit:run')).toBe(false);
  });
});
