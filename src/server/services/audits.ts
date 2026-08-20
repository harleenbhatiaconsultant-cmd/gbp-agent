/**
 * Audit persistence and finding lifecycle.
 *
 * The engine is pure; this is where its output becomes durable history. The
 * important behaviour here is RECONCILIATION: a finding is not re-created every
 * week, it is tracked by fingerprint so a client can see "opened 6 weeks ago,
 * resolved on the 14th" rather than an undifferentiated pile of duplicates.
 */

import type { Prisma } from '@/generated/prisma/client';
import { AuditRunStatus, FindingStatus } from '@/generated/prisma/enums';
import { requireCapability } from '@/server/auth/rbac';
import type { TenantContext } from '@/server/auth/tenant-context';
import { NotFoundError } from '@/server/errors';
import { runAudit } from '@/server/audit/engine';
import { RULESET_VERSION, type ReviewSummary, type RuleContext } from '@/server/audit/types';
import type { HealthScore } from '@/server/audit/scoring';
import type { GbpLocationResource } from '@/server/integrations/google/types';
import { getLatestSnapshot } from '@/server/services/locations';
import { recordAuditEvent } from '@/server/services/audit-events';
import { childLogger } from '@/server/observability/logger';

export interface AuditRunSummary {
  auditRunId: string;
  locationId: string;
  rulesetVersion: string;
  health: HealthScore;
  findingsOpened: number;
  findingsResolved: number;
  findingsCarriedOver: number;
}

/**
 * Builds the review summary the reputation rules need.
 *
 * Returns undefined when no reviews have been synced, which makes those rules
 * report `skipped` rather than passing on absent data. That distinction is the
 * difference between an honest audit and a flattering one.
 */
async function buildReviewSummary(
  ctx: TenantContext,
  locationId: string,
): Promise<ReviewSummary | undefined> {
  const totalCount = await ctx.db.review.count({ where: { locationId } });
  if (totalCount === 0) return undefined;

  const [aggregate, unansweredCount, newest, newestReply] = await Promise.all([
    ctx.db.review.aggregate({ where: { locationId }, _avg: { starRating: true } }),
    ctx.db.review.count({ where: { locationId, replyComment: null } }),
    ctx.db.review.findFirst({
      where: { locationId },
      orderBy: { createTime: 'desc' },
      select: { createTime: true },
    }),
    ctx.db.review.findFirst({
      where: { locationId, replyUpdateTime: { not: null } },
      orderBy: { replyUpdateTime: 'desc' },
      select: { replyUpdateTime: true },
    }),
  ]);

  return {
    totalCount,
    averageRating: Number((aggregate._avg.starRating ?? 0).toFixed(2)),
    unansweredCount,
    newestReviewAt: newest?.createTime ?? null,
    newestOwnerReplyAt: newestReply?.replyUpdateTime ?? null,
  };
}

/** Runs the ruleset against the latest snapshot and records the result. */
export async function runLocationAudit(
  ctx: TenantContext,
  locationId: string,
): Promise<AuditRunSummary> {
  requireCapability(ctx, 'audit:run');

  const location = await ctx.db.location.findFirst({ where: { id: locationId } });
  if (!location) throw new NotFoundError('Location not found.');

  const snapshot = await getLatestSnapshot(ctx, locationId);
  const reviews = await buildReviewSummary(ctx, locationId);
  const log = childLogger({ organizationId: ctx.organizationId, locationId });

  const ruleContext: RuleContext = {
    profile: snapshot.rawPayload as unknown as GbpLocationResource,
    evaluatedAt: new Date(),
    reviews,
  };

  const result = runAudit(ruleContext);
  const currentFingerprints = new Set(result.findings.map((f) => f.fingerprint));

  // Findings still open from earlier runs, used to decide opened vs carried over.
  const previouslyOpen = await ctx.db.auditFinding.findMany({
    where: { locationId, status: FindingStatus.OPEN },
    select: { id: true, fingerprint: true },
  });
  const previousFingerprints = new Set(previouslyOpen.map((f) => f.fingerprint));

  const resolvedIds = previouslyOpen
    .filter((f) => !currentFingerprints.has(f.fingerprint))
    .map((f) => f.id);

  const carriedOver = result.findings.filter((f) =>
    previousFingerprints.has(f.fingerprint),
  ).length;

  const auditRunId = await ctx.db.$transaction(async (tx) => {
    const run = await tx.auditRun.create({
      data: {
        organizationId: ctx.organizationId,
        locationId,
        snapshotId: snapshot.id,
        rulesetVersion: result.rulesetVersion,
        status: AuditRunStatus.COMPLETED,
        healthScore: result.health.score,
        scoreBreakdown: result.health as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });

    if (result.findings.length > 0) {
      await tx.auditFinding.createMany({
        data: result.findings.map((finding) => ({
          organizationId: ctx.organizationId,
          auditRunId: run.id,
          locationId,
          scope: finding.scope,
          ruleId: finding.ruleId,
          category: finding.category,
          severity: finding.severity,
          status: FindingStatus.OPEN,
          title: finding.title,
          detail: finding.detail,
          evidence: (finding.evidence ?? undefined) as Prisma.InputJsonValue | undefined,
          autoFixable: finding.autoFixable,
          suggestedActionType: finding.suggestedActionType,
          fingerprint: finding.fingerprint,
        })),
      });
    }

    // Genuinely fixed: the profile no longer exhibits this issue.
    if (resolvedIds.length > 0) {
      await tx.auditFinding.updateMany({
        where: { id: { in: resolvedIds } },
        data: { status: FindingStatus.RESOLVED, resolvedAt: new Date() },
      });
    }

    // Still present: the older row is superseded by this run's observation, so
    // exactly one OPEN row per fingerprint survives. Deliberately NOT marked
    // RESOLVED — that would report a fix on every audit run and make the
    // client-facing history meaningless.
    const supersededIds = previouslyOpen
      .filter((f) => currentFingerprints.has(f.fingerprint))
      .map((f) => f.id);
    if (supersededIds.length > 0) {
      await tx.auditFinding.updateMany({
        where: { id: { in: supersededIds } },
        data: { status: FindingStatus.SUPERSEDED },
      });
    }

    await tx.location.update({
      where: { id: locationId },
      data: { healthScore: result.health.score, lastAuditAt: new Date() },
    });

    return run.id;
  });

  await recordAuditEvent({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'audit.run',
    subjectType: 'Location',
    subjectId: locationId,
    metadata: {
      auditRunId,
      score: result.health.score,
      findings: result.findings.length,
      coverage: result.health.coverage,
      rulesetVersion: RULESET_VERSION,
    },
  });

  log.info(
    { auditRunId, score: result.health.score, findings: result.findings.length },
    'Audit complete',
  );

  return {
    auditRunId,
    locationId,
    rulesetVersion: result.rulesetVersion,
    health: result.health,
    findingsOpened: result.findings.length - carriedOver,
    findingsResolved: resolvedIds.length,
    findingsCarriedOver: carriedOver,
  };
}

export async function getLatestAuditRun(ctx: TenantContext, locationId: string) {
  requireCapability(ctx, 'location:view');

  return ctx.db.auditRun.findFirst({
    where: { locationId, status: AuditRunStatus.COMPLETED },
    orderBy: { startedAt: 'desc' },
    include: {
      findings: {
        orderBy: [{ severity: 'asc' }, { category: 'asc' }],
      },
    },
  });
}

export async function listAuditHistory(ctx: TenantContext, locationId: string, take = 20) {
  requireCapability(ctx, 'location:view');

  return ctx.db.auditRun.findMany({
    where: { locationId },
    orderBy: { startedAt: 'desc' },
    take,
    select: {
      id: true,
      startedAt: true,
      healthScore: true,
      rulesetVersion: true,
      status: true,
      _count: { select: { findings: true } },
    },
  });
}

/** Dismisses a finding the customer has judged not applicable. */
export async function ignoreFinding(
  ctx: TenantContext,
  findingId: string,
): Promise<void> {
  requireCapability(ctx, 'change:draft');

  const finding = await ctx.db.auditFinding.findFirst({ where: { id: findingId } });
  if (!finding) throw new NotFoundError('Finding not found.');

  await ctx.db.auditFinding.update({
    where: { id: findingId },
    data: { status: FindingStatus.IGNORED },
  });
}
