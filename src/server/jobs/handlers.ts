/**
 * Job handlers.
 *
 * Each handler is a thin adapter: resolve a system context, call the service
 * that already does the work, summarise the outcome. No business logic lives
 * here — a job and a button in the UI must do exactly the same thing, and the
 * only way to guarantee that is for both to call the same service.
 *
 * The two `fanout` handlers are the scheduling pattern: a single repeatable job
 * enumerates work and enqueues one job per subject with a deterministic id.
 * That avoids managing a repeatable job per customer, and makes a scheduler
 * restart harmless.
 */

import { ChangeRequestStatus, ConnectionStatus } from '@/generated/prisma/enums';
import { prisma } from '@/server/db';
import { loadSystemContext } from '@/server/auth/system-context';
import { syncConnection, syncLocation } from '@/server/services/locations';
import { runLocationAudit } from '@/server/services/audits';
import { executeChange, verifyChange } from '@/server/services/changes';
import { getAccessToken } from '@/server/services/connections';
import { enqueue } from '@/server/jobs/queues';
import { bucket, jobId } from '@/server/jobs/types';
import { reapStaleJobRuns } from '@/server/jobs/runner';
import { logger } from '@/server/observability/logger';
import type { JobOutcome } from '@/server/jobs/runner';

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** Enqueues a daily sync for every active connection, across all tenants. */
export async function handleSyncFanout(): Promise<JobOutcome<{ enqueued: number }>> {
  const connections = await prisma.googleConnection.findMany({
    where: { status: ConnectionStatus.ACTIVE, organization: { status: 'ACTIVE' } },
    select: { id: true, organizationId: true },
  });

  const today = bucket.day();
  let enqueued = 0;

  for (const connection of connections) {
    const result = await enqueue(
      {
        name: 'sync.connection',
        data: { organizationId: connection.organizationId, connectionId: connection.id },
      },
      { jobId: jobId('sync.connection', connection.id, today) },
    );
    if (result.enqueued) enqueued += 1;
  }

  return {
    result: { enqueued },
    summary: `Enqueued ${enqueued} of ${connections.length} connection syncs`,
  };
}

export async function handleSyncConnection(data: {
  organizationId: string;
  connectionId: string;
}): Promise<JobOutcome<{ locations: number }>> {
  const ctx = await loadSystemContext(data.organizationId);
  const result = await syncConnection(ctx, data.connectionId);

  return {
    result: { locations: result.locationsImported + result.locationsUpdated },
    summary:
      `${result.locationsImported} imported, ${result.locationsUpdated} updated, ` +
      `${result.snapshotsCreated} new snapshots, ${result.locationsUnchanged} unchanged`,
  };
}

export async function handleSyncLocation(data: {
  organizationId: string;
  locationId: string;
}): Promise<JobOutcome<{ snapshotCreated: boolean }>> {
  const ctx = await loadSystemContext(data.organizationId);
  const result = await syncLocation(ctx, data.locationId);

  return {
    result,
    summary: result.snapshotCreated
      ? 'Profile changed; new snapshot recorded'
      : 'Profile unchanged since last sync',
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Enqueues a weekly audit for every location that has something to audit.
 *
 * Locations with no snapshot are skipped rather than failed: there is nothing
 * to run the ruleset against, and a queue full of predictable failures buries
 * the real ones.
 */
export async function handleAuditFanout(): Promise<JobOutcome<{ enqueued: number }>> {
  const locations = await prisma.location.findMany({
    where: {
      organization: { status: 'ACTIVE' },
      snapshots: { some: {} },
    },
    select: { id: true, organizationId: true },
  });

  const week = bucket.week();
  let enqueued = 0;

  for (const location of locations) {
    const result = await enqueue(
      {
        name: 'audit.location',
        data: { organizationId: location.organizationId, locationId: location.id },
      },
      { jobId: jobId('audit.location', location.id, week) },
    );
    if (result.enqueued) enqueued += 1;
  }

  return {
    result: { enqueued },
    summary: `Enqueued ${enqueued} of ${locations.length} location audits`,
  };
}

export async function handleAuditLocation(data: {
  organizationId: string;
  locationId: string;
}): Promise<JobOutcome<{ score: number | null }>> {
  const ctx = await loadSystemContext(data.organizationId);
  const summary = await runLocationAudit(ctx, data.locationId);

  return {
    result: { score: summary.health.score },
    summary:
      `Score ${summary.health.score ?? 'n/a'} · ${summary.findingsOpened} opened, ` +
      `${summary.findingsResolved} resolved, ${summary.findingsCarriedOver} carried over`,
  };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

/**
 * Carries out an approved change.
 *
 * The job presents no authority of its own: `executeChange` checks that a named
 * human approved the request before it will act on a system context.
 */
export async function handleExecuteChange(data: {
  organizationId: string;
  changeRequestId: string;
}): Promise<JobOutcome<{ applied: boolean }>> {
  const ctx = await loadSystemContext(data.organizationId);
  const result = await executeChange(ctx, data.changeRequestId);

  // Verification only means something after a real write.
  if (result.applied) {
    await enqueue(
      {
        name: 'change.verify',
        data: { organizationId: data.organizationId, changeRequestId: data.changeRequestId },
      },
      {
        jobId: jobId('change.verify', data.changeRequestId, bucket.day()),
        // Google needs a moment to serve the updated value.
        delayMs: 5 * 60_000,
      },
    );
  }

  return { result: { applied: result.applied }, summary: result.message };
}

export async function handleVerifyChange(data: {
  organizationId: string;
  changeRequestId: string;
}): Promise<JobOutcome<{ matched: boolean }>> {
  const ctx = await loadSystemContext(data.organizationId);
  const result = await verifyChange(ctx, data.changeRequestId);

  return { result: { matched: result.matched }, summary: result.notes };
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Refreshes every active connection ahead of time.
 *
 * The point is early warning, not the token itself: a customer who revoked
 * access at Google looks fine until something tries to use the connection.
 * Sweeping hourly means the platform notices within the hour and can tell them,
 * instead of discovering it during a scheduled sync at 3am.
 */
export async function handleTokenRefreshSweep(): Promise<
  JobOutcome<{ checked: number; failed: number }>
> {
  const connections = await prisma.googleConnection.findMany({
    where: { status: ConnectionStatus.ACTIVE },
    select: { id: true, organizationId: true, googleAccountEmail: true },
  });

  let failed = 0;

  for (const connection of connections) {
    try {
      // getAccessToken refreshes, and on invalid_grant marks the connection
      // NEEDS_RECONSENT and records an audit event.
      await getAccessToken(connection.organizationId, connection.id);
    } catch (error) {
      failed += 1;
      logger.warn(
        { err: error, connectionId: connection.id, email: connection.googleAccountEmail },
        'Connection failed its refresh sweep',
      );
    }
  }

  return {
    result: { checked: connections.length, failed },
    summary: `${connections.length} checked, ${failed} need attention`,
  };
}

/**
 * Prunes old snapshots.
 *
 * Keeps: anything recent, the first snapshot of each month, and anything an
 * AuditRun references. That last one is what keeps historical audits
 * reproducible — deleting a snapshot an audit was computed from would turn its
 * score into an unexplainable number.
 */
export async function handleSnapshotPrune(
  retentionDays = 90,
): Promise<JobOutcome<{ deleted: number }>> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const candidates = await prisma.locationSnapshot.findMany({
    where: {
      capturedAt: { lt: cutoff },
      auditRuns: { none: {} },
    },
    select: { id: true, locationId: true, capturedAt: true },
    orderBy: { capturedAt: 'asc' },
  });

  // Keep the first snapshot of each month per location as a long-term marker.
  const keep = new Set<string>();
  const seenMonths = new Set<string>();
  for (const snapshot of candidates) {
    const key = `${snapshot.locationId}:${snapshot.capturedAt.toISOString().slice(0, 7)}`;
    if (!seenMonths.has(key)) {
      seenMonths.add(key);
      keep.add(snapshot.id);
    }
  }

  const deletable = candidates.filter((s) => !keep.has(s.id)).map((s) => s.id);
  if (deletable.length === 0) {
    return { result: { deleted: 0 }, summary: 'Nothing to prune' };
  }

  const { count } = await prisma.locationSnapshot.deleteMany({
    where: { id: { in: deletable } },
  });

  return {
    result: { deleted: count },
    summary: `Pruned ${count} snapshots older than ${retentionDays} days`,
  };
}

export async function handleReapStaleJobs(): Promise<JobOutcome<{ reaped: number }>> {
  const reaped = await reapStaleJobRuns(60);
  return {
    result: { reaped },
    summary: reaped > 0 ? `Marked ${reaped} abandoned job runs as failed` : 'No stale runs',
  };
}

// ---------------------------------------------------------------------------
// On-demand enqueueing, used by the UI
// ---------------------------------------------------------------------------

/** Queues an approved change for background execution. */
export async function enqueueChangeExecution(
  organizationId: string,
  changeRequestId: string,
): Promise<{ enqueued: boolean; reason?: string }> {
  const request = await prisma.changeRequest.findFirst({
    where: { id: changeRequestId, organizationId },
    select: { status: true, approvedByUserId: true },
  });

  if (!request) return { enqueued: false, reason: 'Change request not found.' };

  if (request.status !== ChangeRequestStatus.APPROVED) {
    return { enqueued: false, reason: `Change is ${request.status}, not APPROVED.` };
  }

  if (!request.approvedByUserId) {
    return { enqueued: false, reason: 'Change has no recorded approver.' };
  }

  return enqueue(
    { name: 'change.execute', data: { organizationId, changeRequestId } },
    { jobId: jobId('change.execute', changeRequestId, bucket.hour()) },
  );
}
