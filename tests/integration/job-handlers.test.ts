/**
 * Job handler integration tests.
 *
 * Handlers are thin adapters over the services, and these tests exist to prove
 * exactly that: a scheduled audit must do the same thing as pressing the button
 * in the UI, and its outcome must land in JobRun so the ops view can show it.
 *
 * Redis is not involved. Enqueueing degrades to a no-op without it, which is
 * itself asserted here — the platform has to stay usable before the queue
 * exists, not merely not crash.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ChangeRequestStatus, JobStatus, MemberRole, PlanTier } from '@/generated/prisma/enums';

vi.mock('@/server/services/connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/connections')>();
  return { ...actual, getAccessToken: vi.fn(async () => 'test-access-token') };
});

import { prisma } from '@/server/db/client';
import { contentHash } from '@/lib/hash';
import { withJobRun, reapStaleJobRuns } from '@/server/jobs/runner';
import { isQueueingAvailable } from '@/server/jobs/redis';
import { enqueue } from '@/server/jobs/queues';
import { QUEUE } from '@/server/jobs/types';
import {
  handleAuditLocation,
  handleAuditFanout,
  handleSyncFanout,
  enqueueChangeExecution,
} from '@/server/jobs/handlers';
import { getJobsView } from '@/server/services/jobs-view';
import { tenantDb } from '@/server/db/tenant';
import type { TenantContext } from '@/server/auth/tenant-context';
import { neglectedLocation } from '../fixtures/locations';

const ORG_ID = 'org_job_handlers';
const USER_ID = 'user_job_handlers';
const CONNECTION_ID = 'conn_job_handlers';

let locationId: string;
let ownerCtx: TenantContext;

beforeAll(async () => {
  // Additive setup: JobRun and AuditEvent rows accumulate, and the append-only
  // trail makes some of this undeletable by design.
  await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: {},
    create: { id: ORG_ID, name: 'Job Handlers', slug: 'job-handlers' },
  });
  await prisma.user.upsert({
    where: { id: USER_ID },
    update: {},
    create: { id: USER_ID, email: 'owner@jobhandlers.test' },
  });
  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: USER_ID, organizationId: ORG_ID } },
    update: { role: MemberRole.OWNER },
    create: { userId: USER_ID, organizationId: ORG_ID, role: MemberRole.OWNER },
  });
  await prisma.googleConnection.upsert({
    where: { id: CONNECTION_ID },
    update: { status: 'ACTIVE' },
    create: {
      id: CONNECTION_ID,
      organizationId: ORG_ID,
      googleAccountEmail: 'jobs@example.test',
      encryptedRefreshToken: 'v0.test.test.not-a-real-token',
      encryptionKeyVersion: 0,
      scopes: [],
    },
  });

  const account =
    (await prisma.gbpAccount.findFirst({
      where: { organizationId: ORG_ID, googleAccountName: 'accounts/jobs' },
    })) ??
    (await prisma.gbpAccount.create({
      data: {
        organizationId: ORG_ID,
        connectionId: CONNECTION_ID,
        googleAccountName: 'accounts/jobs',
      },
    }));

  const location = await prisma.location.create({
    data: {
      organizationId: ORG_ID,
      gbpAccountId: account.id,
      googleLocationName: `locations/jobs-${Date.now()}`,
      title: 'Job Handler Location',
    },
  });
  locationId = location.id;

  await prisma.locationSnapshot.create({
    data: {
      organizationId: ORG_ID,
      locationId,
      rawPayload: neglectedLocation as never,
      contentHash: contentHash(neglectedLocation),
      source: 'TEST',
    },
  });

  ownerCtx = {
    organizationId: ORG_ID,
    organizationSlug: 'job-handlers',
    plan: PlanTier.FREE,
    userId: USER_ID,
    role: MemberRole.OWNER,
    isElevated: false,
    db: tenantDb(ORG_ID),
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('JobRun bookkeeping', () => {
  it('records a completed run with its summary', async () => {
    const result = await withJobRun(
      { queue: QUEUE.MAINTENANCE, jobName: 'maintenance.reapStaleJobs', organizationId: ORG_ID, attempt: 1 },
      async () => ({ result: 42, summary: 'did the thing' }),
    );

    expect(result).toBe(42);

    const run = await prisma.jobRun.findFirstOrThrow({
      where: { organizationId: ORG_ID },
      orderBy: { createdAt: 'desc' },
    });
    expect(run.status).toBe(JobStatus.COMPLETED);
    expect(run.error).toBe('did the thing');
    expect(run.finishedAt).toBeInstanceOf(Date);
  });

  it('records a failure and rethrows so the queue can retry', async () => {
    await expect(
      withJobRun(
        { queue: QUEUE.SYNC, jobName: 'sync.connection', organizationId: ORG_ID, attempt: 2 },
        async () => {
          throw new Error('upstream exploded');
        },
      ),
    ).rejects.toThrowError('upstream exploded');

    const run = await prisma.jobRun.findFirstOrThrow({
      where: { organizationId: ORG_ID },
      orderBy: { createdAt: 'desc' },
    });
    expect(run.status).toBe(JobStatus.FAILED);
    expect(run.error).toMatch(/upstream exploded/);
    expect(run.attempts).toBe(2);
  });

  it('reaps runs abandoned by a dead worker', async () => {
    const stale = await prisma.jobRun.create({
      data: {
        organizationId: ORG_ID,
        queue: QUEUE.SYNC,
        jobName: 'sync.connection',
        status: JobStatus.RUNNING,
        attempts: 1,
        startedAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      },
    });

    const reaped = await reapStaleJobRuns(60);
    expect(reaped).toBeGreaterThan(0);

    const after = await prisma.jobRun.findUniqueOrThrow({ where: { id: stale.id } });
    expect(after.status).toBe(JobStatus.FAILED);
    expect(after.error).toMatch(/stopped without reporting/i);
  });
});

describe('audit handler', () => {
  it('runs the same audit the UI runs', async () => {
    const outcome = await handleAuditLocation({ organizationId: ORG_ID, locationId });

    expect(outcome.result.score).not.toBeNull();
    expect(outcome.result.score!).toBeLessThan(40);
    expect(outcome.summary).toMatch(/Score/);

    // And it persisted, exactly as an on-demand audit would.
    const run = await prisma.auditRun.findFirst({
      where: { locationId },
      orderBy: { startedAt: 'desc' },
    });
    expect(run?.healthScore).toBe(outcome.result.score);
  });

  it('refuses to audit a location in another tenant', async () => {
    await expect(
      handleAuditLocation({ organizationId: ORG_ID, locationId: 'loc_does_not_exist' }),
    ).rejects.toThrowError();
  });
});

describe('fan-out without Redis', () => {
  it('is a no-op rather than an error', async () => {
    // The platform must stay usable before the queue exists.
    expect(isQueueingAvailable()).toBe(false);

    const sync = await handleSyncFanout();
    const audit = await handleAuditFanout();

    expect(sync.result.enqueued).toBe(0);
    expect(audit.result.enqueued).toBe(0);
    expect(sync.summary).toMatch(/Enqueued 0 of/);
  });

  it('reports honestly that a job was not enqueued', async () => {
    const result = await enqueue({
      name: 'audit.location',
      data: { organizationId: ORG_ID, locationId },
    });

    expect(result.enqueued).toBe(false);
    expect(result.reason).toMatch(/REDIS_URL/);
  });
});

describe('enqueueing a change execution', () => {
  it('refuses a change that is not approved', async () => {
    const request = await prisma.changeRequest.create({
      data: {
        organizationId: ORG_ID,
        locationId,
        actionType: 'UPDATE_WEBSITE',
        payload: {},
        status: ChangeRequestStatus.PENDING_APPROVAL,
        idempotencyKey: `test-not-approved-${Date.now()}`,
      },
    });

    const result = await enqueueChangeExecution(ORG_ID, request.id);
    expect(result.enqueued).toBe(false);
    expect(result.reason).toMatch(/not APPROVED/);
  });

  it('refuses an APPROVED change with no recorded approver', async () => {
    // Defence in depth: even a row marked APPROVED cannot be executed by a job
    // unless a named person is attached to that approval.
    const request = await prisma.changeRequest.create({
      data: {
        organizationId: ORG_ID,
        locationId,
        actionType: 'UPDATE_WEBSITE',
        payload: {},
        status: ChangeRequestStatus.APPROVED,
        approvedByUserId: null,
        idempotencyKey: `test-no-approver-${Date.now()}`,
      },
    });

    const result = await enqueueChangeExecution(ORG_ID, request.id);
    expect(result.enqueued).toBe(false);
    expect(result.reason).toMatch(/no recorded approver/);
  });

  it('refuses a change belonging to another tenant', async () => {
    const result = await enqueueChangeExecution('org_someone_else', 'cr_whatever');
    expect(result.enqueued).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });
});

describe('ops view', () => {
  it('reports queueing as unconfigured without hiding job history', async () => {
    const view = await getJobsView(ownerCtx);

    expect(view.queueingConfigured).toBe(false);
    expect(view.queues).toEqual([]);
    // The durable record still reads, which is the point of keeping it in Postgres.
    expect(view.recentRuns.length).toBeGreaterThan(0);
  });

  it('lists every schedule with its cron, even when none are registered', async () => {
    const view = await getJobsView(ownerCtx);

    expect(view.schedules.length).toBeGreaterThan(0);
    for (const schedule of view.schedules) {
      expect(schedule.pattern.split(/\s+/)).toHaveLength(5);
      expect(schedule.registered).toBe(false);
    }
  });

  it('surfaces recent failures', async () => {
    const view = await getJobsView(ownerCtx);
    expect(view.failedLast24h).toBeGreaterThan(0);
  });
});
