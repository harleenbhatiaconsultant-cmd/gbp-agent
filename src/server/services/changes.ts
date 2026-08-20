/**
 * The change pipeline: propose -> policy -> approve -> execute -> verify.
 *
 * This is the service that turns an intention into a real edit on a customer's
 * business listing, and every safeguard in the architecture converges here.
 *
 * The properties this file is responsible for keeping true:
 *
 *   1. A BLOCKED change never becomes a ChangeRequest at all. The refusal is
 *      recorded as a PolicyViolation and no approval can override it.
 *   2. Execution ALWAYS dry-runs first. Google has no sandbox, so validateOnly
 *      is the only rehearsal available.
 *   3. A live write happens only when the write mode explicitly permits it.
 *      With the default configuration this function cannot reach a live profile
 *      even with valid credentials loaded.
 *   4. The status transition and the ChangeLog entry share one transaction, so
 *      "we applied it" and "we recorded it" cannot diverge.
 *   5. A retried execution never double-applies, because a terminal execution
 *      for the same idempotency key short-circuits.
 */

import { createHash } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import {
  ActionType,
  ChangeActor,
  ChangeRequestStatus,
  ExecutionStatus,
  PolicyDecisionType,
  RecommendationStatus,
} from '@/generated/prisma/enums';
import { prisma } from '@/server/db';
import { requireCapability, requireHumanApprover } from '@/server/auth/rbac';
import type { TenantContext } from '@/server/auth/tenant-context';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  PolicyBlockedError,
  ValidationError,
} from '@/server/errors';
import { canAutoApply, getWriteMode, isDryRun } from '@/config/features';
import { getExecutor } from '@/server/actions/registry';
import { evaluatePolicy } from '@/server/policy/engine';
import type { PolicyResult } from '@/server/policy/types';
import { getGbpProvider } from '@/server/integrations/google/direct-provider';
import { isGbpError } from '@/server/integrations/google/errors';
import type { GbpLocationResource } from '@/server/integrations/google/types';
import { getAccessToken } from '@/server/services/connections';
import { recordAuditEvent } from '@/server/services/audit-events';
import { stableStringify } from '@/lib/hash';
import { childLogger } from '@/server/observability/logger';

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export interface ProposeChangeInput {
  locationId: string;
  actionType: ActionType;
  payload: unknown;
  recommendationId?: string;
}

export interface ProposeChangeResult {
  changeRequestId: string;
  status: ChangeRequestStatus;
  policy: PolicyResult;
  /** True when an identical pending proposal already existed. */
  deduplicated: boolean;
}

/**
 * Derives a stable key for "this exact change to this exact location".
 * Two identical proposals collapse to one request rather than queueing twice.
 */
function idempotencyKeyFor(
  locationId: string,
  actionType: ActionType,
  payload: unknown,
): string {
  const digest = createHash('sha256')
    .update(`${locationId}:${actionType}:${stableStringify(payload)}`)
    .digest('hex')
    .slice(0, 32);
  return `${actionType}:${locationId}:${digest}`;
}

async function loadCurrentProfile(
  ctx: TenantContext,
  locationId: string,
): Promise<GbpLocationResource> {
  const snapshot = await ctx.db.locationSnapshot.findFirst({
    where: { locationId },
    orderBy: { capturedAt: 'desc' },
  });

  if (!snapshot) {
    throw new BadRequestError(
      'This location has no snapshot yet. Sync it from Google before proposing changes — ' +
        'a change cannot be assessed without knowing the current state.',
    );
  }

  return snapshot.rawPayload as unknown as GbpLocationResource;
}

/** Real edits applied to this location since midnight, for blast-radius limits. */
async function countChangesAppliedToday(
  ctx: TenantContext,
  locationId: string,
): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  return ctx.db.changeLog.count({
    where: { locationId, createdAt: { gte: startOfDay } },
  });
}

/**
 * Validates, evaluates policy, and creates a ChangeRequest.
 *
 * Throws PolicyBlockedError — without creating anything — when a guardrail
 * blocks. The refusal itself is recorded permanently as a PolicyViolation.
 */
export async function proposeChange(
  ctx: TenantContext,
  input: ProposeChangeInput,
): Promise<ProposeChangeResult> {
  requireCapability(ctx, 'change:draft');

  const location = await ctx.db.location.findFirst({ where: { id: input.locationId } });
  if (!location) throw new NotFoundError('Location not found.');

  // Resolving the executor first means an unimplemented action is refused
  // before any policy work happens.
  const executor = getExecutor(input.actionType);

  const parsed = executor.schema.safeParse(input.payload);
  if (!parsed.success) {
    throw new ValidationError('The proposed change failed validation.', {
      actionType: input.actionType,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }

  const currentProfile = await loadCurrentProfile(ctx, input.locationId);
  const changesAppliedToday = await countChangesAppliedToday(ctx, input.locationId);

  const policy = evaluatePolicy({
    actionType: input.actionType,
    payload: parsed.data as Record<string, unknown>,
    currentProfile,
    changesAppliedToday,
  });

  const log = childLogger({
    organizationId: ctx.organizationId,
    locationId: input.locationId,
    actionType: input.actionType,
  });

  // ---- blocked: record the refusal, create nothing --------------------------
  if (policy.decision === PolicyDecisionType.BLOCK) {
    await ctx.db.policyViolation.createMany({
      data: policy.blockers.map((blocker) => ({
        organizationId: ctx.organizationId,
        subjectType: 'ChangeProposal',
        subjectId: input.locationId,
        ruleId: blocker.ruleId,
        decision: PolicyDecisionType.BLOCK,
        severity: blocker.severity,
        detail: blocker.detail,
        payloadSample: (blocker.evidence ?? {}) as Prisma.InputJsonValue,
      })),
    });

    log.warn(
      { blockers: policy.blockers.map((b) => b.ruleId) },
      'Change proposal blocked by policy',
    );

    throw new PolicyBlockedError(
      policy.blockers[0].ruleId,
      policy.blockers.map((b) => b.detail).join(' '),
      { blockers: policy.blockers.map((b) => b.ruleId) },
    );
  }

  const idempotencyKey = idempotencyKeyFor(input.locationId, input.actionType, parsed.data);

  const existing = await ctx.db.changeRequest.findFirst({ where: { idempotencyKey } });
  if (existing) {
    return {
      changeRequestId: existing.id,
      status: existing.status,
      policy,
      deduplicated: true,
    };
  }

  // ---- decide whether a human must approve ---------------------------------
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId },
    select: { settings: true },
  });
  const settings = (organization.settings ?? {}) as { autoApply?: ActionType[] };

  const autoApply =
    policy.decision === PolicyDecisionType.ALLOW
      ? canAutoApply({
          actionType: input.actionType,
          riskLevel: policy.riskLevel,
          organizationAutoApplyActions: settings.autoApply ?? [],
        })
      : {
          allowed: false,
          reason: 'A compliance guardrail requires a human approver for this change.',
        };

  const status = autoApply.allowed
    ? ChangeRequestStatus.APPROVED
    : ChangeRequestStatus.PENDING_APPROVAL;

  const changeRequest = await ctx.db.changeRequest.create({
    data: {
      organizationId: ctx.organizationId,
      locationId: input.locationId,
      recommendationId: input.recommendationId ?? null,
      actionType: input.actionType,
      payload: parsed.data as Prisma.InputJsonValue,
      riskLevel: policy.riskLevel,
      policyDecision: {
        decision: policy.decision,
        riskLevel: policy.riskLevel,
        autoApply,
        findings: policy.findings,
      } as unknown as Prisma.InputJsonValue,
      status,
      requestedByUserId: ctx.userId,
      approvedByUserId: autoApply.allowed ? null : undefined,
      approvedAt: autoApply.allowed ? new Date() : undefined,
      idempotencyKey,
    },
  });

  if (input.recommendationId) {
    await ctx.db.recommendation.updateMany({
      where: { id: input.recommendationId },
      data: { status: RecommendationStatus.ACCEPTED },
    });
  }

  await recordAuditEvent({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'change.requested',
    subjectType: 'ChangeRequest',
    subjectId: changeRequest.id,
    metadata: {
      actionType: input.actionType,
      riskLevel: policy.riskLevel,
      decision: policy.decision,
      autoApproved: autoApply.allowed,
    },
  });

  log.info({ changeRequestId: changeRequest.id, status }, 'Change proposed');

  return { changeRequestId: changeRequest.id, status, policy, deduplicated: false };
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export async function approveChange(ctx: TenantContext, changeRequestId: string): Promise<void> {
  // Deliberately stricter than a capability check: approval is the moment a
  // real mutation becomes authorized, so it must be attributable to a person.
  const approver = requireHumanApprover(ctx);

  const request = await ctx.db.changeRequest.findFirst({ where: { id: changeRequestId } });
  if (!request) throw new NotFoundError('Change request not found.');

  if (request.status !== ChangeRequestStatus.PENDING_APPROVAL) {
    throw new ConflictError(
      `This change is ${request.status} and cannot be approved.`,
      { status: request.status },
    );
  }

  if (request.requestedByUserId && request.requestedByUserId === approver.userId) {
    // Not blocked outright — in a small team the proposer is often the only
    // admin — but it is recorded, so four-eyes can be audited later.
    childLogger({ organizationId: ctx.organizationId, changeRequestId }).info(
      { userId: approver.userId },
      'Change approved by its own proposer',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.changeRequest.update({
      where: { id: changeRequestId },
      data: {
        status: ChangeRequestStatus.APPROVED,
        approvedByUserId: approver.userId,
        approvedAt: new Date(),
      },
    });

    await recordAuditEvent(
      {
        organizationId: ctx.organizationId,
        actorUserId: approver.userId,
        action: 'change.approved',
        subjectType: 'ChangeRequest',
        subjectId: changeRequestId,
        metadata: { actionType: request.actionType, riskLevel: request.riskLevel },
      },
      tx,
    );
  });
}

export async function rejectChange(
  ctx: TenantContext,
  changeRequestId: string,
  reason: string,
): Promise<void> {
  requireCapability(ctx, 'change:approve');

  const request = await ctx.db.changeRequest.findFirst({ where: { id: changeRequestId } });
  if (!request) throw new NotFoundError('Change request not found.');

  if (request.status !== ChangeRequestStatus.PENDING_APPROVAL) {
    throw new ConflictError(`This change is ${request.status} and cannot be rejected.`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.changeRequest.update({
      where: { id: changeRequestId },
      data: { status: ChangeRequestStatus.REJECTED, rejectedReason: reason.slice(0, 500) },
    });

    if (request.recommendationId) {
      await tx.recommendation.updateMany({
        where: { id: request.recommendationId },
        data: { status: RecommendationStatus.DISMISSED },
      });
    }

    await recordAuditEvent(
      {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'change.rejected',
        subjectType: 'ChangeRequest',
        subjectId: changeRequestId,
        metadata: { actionType: request.actionType, reason: reason.slice(0, 200) },
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ExecuteChangeResult {
  changeRequestId: string;
  /** The dry run passed Google validation. */
  validated: boolean;
  /** A real mutation was performed. False whenever write mode is validate_only. */
  applied: boolean;
  writeMode: string;
  executionIds: string[];
  message: string;
}

/**
 * Executes an approved change.
 *
 * Sequence, in order, every time:
 *   1. refuse anything not APPROVED
 *   2. short-circuit if a terminal execution already exists (idempotency)
 *   3. DRY RUN against Google with validateOnly=true
 *   4. stop there unless the write mode explicitly permits a live write
 *   5. apply for real, then record ChangeLog and the status transition together
 */
export async function executeChange(
  ctx: TenantContext,
  changeRequestId: string,
): Promise<ExecuteChangeResult> {
  requireCapability(ctx, 'change:execute');

  const request = await ctx.db.changeRequest.findFirst({
    where: { id: changeRequestId },
    include: {
      location: {
        select: {
          id: true,
          googleLocationName: true,
          gbpAccount: { select: { connectionId: true } },
        },
      },
    },
  });
  if (!request) throw new NotFoundError('Change request not found.');

  if (request.status === ChangeRequestStatus.EXECUTED) {
    // Idempotency: a retry of an already-applied change is a no-op, not a
    // second write to the customer profile.
    return {
      changeRequestId,
      validated: true,
      applied: true,
      writeMode: getWriteMode(),
      executionIds: [],
      message: 'This change was already executed. Nothing was sent to Google.',
    };
  }

  if (request.status !== ChangeRequestStatus.APPROVED) {
    throw new ConflictError(
      `This change is ${request.status}; only an APPROVED change can be executed.`,
      { status: request.status },
    );
  }

  const executor = getExecutor(request.actionType);
  const payload = executor.schema.parse(request.payload);
  const { patch, updateMask } = executor.buildPatch(payload);

  const currentProfile = await loadCurrentProfile(ctx, request.locationId);
  const beforeState = executor.captureBefore(currentProfile);

  const provider = getGbpProvider();
  const accessToken = await getAccessToken(
    ctx.organizationId,
    request.location.gbpAccount.connectionId,
  );
  const providerCtx = {
    accessToken,
    logContext: { organizationId: ctx.organizationId, changeRequestId },
  };

  const log = childLogger({
    organizationId: ctx.organizationId,
    changeRequestId,
    actionType: request.actionType,
  });

  const nextAttempt =
    (await ctx.db.changeExecution.count({ where: { changeRequestId } })) + 1;

  await ctx.db.changeRequest.updateMany({
    where: { id: changeRequestId },
    data: { status: ChangeRequestStatus.EXECUTING },
  });

  const executionIds: string[] = [];

  // ---- 3. dry run ---------------------------------------------------------
  const dryRunExecution = await ctx.db.changeExecution.create({
    data: {
      organizationId: ctx.organizationId,
      changeRequestId,
      attempt: nextAttempt,
      dryRun: true,
      status: ExecutionStatus.RUNNING,
      requestPayload: { patch, updateMask } as unknown as Prisma.InputJsonValue,
      beforeState: beforeState as Prisma.InputJsonValue,
    },
  });
  executionIds.push(dryRunExecution.id);

  try {
    const response = await provider.updateLocation(
      providerCtx,
      request.location.googleLocationName,
      patch,
      updateMask,
      { validateOnly: true },
    );

    await ctx.db.changeExecution.update({
      where: { id: dryRunExecution.id },
      data: {
        status: ExecutionStatus.SUCCEEDED,
        responsePayload: (response ?? {}) as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });
  } catch (error) {
    const { code, message } = describeFailure(error);

    await ctx.db.changeExecution.update({
      where: { id: dryRunExecution.id },
      data: {
        status: ExecutionStatus.FAILED,
        errorCode: code,
        errorMessage: message,
        finishedAt: new Date(),
      },
    });
    await ctx.db.changeRequest.updateMany({
      where: { id: changeRequestId },
      data: { status: ChangeRequestStatus.FAILED },
    });

    log.error({ err: error }, 'Dry run rejected by Google; change not applied');

    return {
      changeRequestId,
      validated: false,
      applied: false,
      writeMode: getWriteMode(),
      executionIds,
      message: `Google rejected this change during validation: ${message}`,
    };
  }

  // ---- 4. the live-write gate --------------------------------------------
  if (isDryRun()) {
    // The default path. Validation passed and nothing was mutated. The request
    // returns to APPROVED so it can be applied later without re-approval.
    await ctx.db.changeRequest.updateMany({
      where: { id: changeRequestId },
      data: { status: ChangeRequestStatus.APPROVED },
    });

    log.info({ writeMode: getWriteMode() }, 'Dry run succeeded; live write not permitted');

    return {
      changeRequestId,
      validated: true,
      applied: false,
      writeMode: getWriteMode(),
      executionIds,
      message:
        'Validated successfully against Google. No change was made: the platform is in ' +
        `${getWriteMode()} mode, so nothing is written to a live profile.`,
    };
  }

  // ---- 5. live application ------------------------------------------------
  const liveExecution = await ctx.db.changeExecution.create({
    data: {
      organizationId: ctx.organizationId,
      changeRequestId,
      attempt: nextAttempt + 1,
      dryRun: false,
      status: ExecutionStatus.RUNNING,
      requestPayload: { patch, updateMask } as unknown as Prisma.InputJsonValue,
      beforeState: beforeState as Prisma.InputJsonValue,
    },
  });
  executionIds.push(liveExecution.id);

  try {
    const response = await provider.updateLocation(
      providerCtx,
      request.location.googleLocationName,
      patch,
      updateMask,
      { validateOnly: false },
    );

    const afterState = executor.captureBefore(response ?? ({} as GbpLocationResource));

    // The execution record, the change log and the status move together. A
    // change that was applied but not recorded would break the audit trail.
    await prisma.$transaction(async (tx) => {
      await tx.changeExecution.update({
        where: { id: liveExecution.id },
        data: {
          status: ExecutionStatus.SUCCEEDED,
          responsePayload: (response ?? {}) as unknown as Prisma.InputJsonValue,
          afterState: afterState as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });

      await tx.changeRequest.update({
        where: { id: changeRequestId },
        data: { status: ChangeRequestStatus.EXECUTED },
      });

      await tx.changeLog.create({
        data: {
          organizationId: ctx.organizationId,
          locationId: request.locationId,
          changeRequestId,
          actor: request.requestedByUserId ? ChangeActor.USER : ChangeActor.SYSTEM,
          actorUserId: request.approvedByUserId ?? request.requestedByUserId,
          actionType: request.actionType,
          summary: executor.describe(payload, currentProfile),
          beforeState: beforeState as Prisma.InputJsonValue,
          afterState: afterState as Prisma.InputJsonValue,
        },
      });

      await recordAuditEvent(
        {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'change.executed',
          subjectType: 'ChangeRequest',
          subjectId: changeRequestId,
          metadata: { actionType: request.actionType, updateMask },
        },
        tx,
      );
    });

    log.info({ updateMask }, 'Change applied to live profile');

    return {
      changeRequestId,
      validated: true,
      applied: true,
      writeMode: getWriteMode(),
      executionIds,
      message: 'Change applied to the live profile.',
    };
  } catch (error) {
    const { code, message } = describeFailure(error);

    await ctx.db.changeExecution.update({
      where: { id: liveExecution.id },
      data: {
        status: ExecutionStatus.FAILED,
        errorCode: code,
        errorMessage: message,
        finishedAt: new Date(),
      },
    });
    await ctx.db.changeRequest.updateMany({
      where: { id: changeRequestId },
      data: { status: ChangeRequestStatus.FAILED },
    });

    log.error({ err: error }, 'Live write failed');

    return {
      changeRequestId,
      validated: true,
      applied: false,
      writeMode: getWriteMode(),
      executionIds,
      message: `The change validated but failed when applied: ${message}`,
    };
  }
}

function describeFailure(error: unknown): { code: string; message: string } {
  if (isGbpError(error)) {
    return { code: error.kind, message: error.message.slice(0, 1000) };
  }
  return {
    code: 'unknown',
    message: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown failure',
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Confirms that Google actually persisted a change.
 *
 * A mismatch means the edit was silently rejected, or another editor or
 * Google's own systems reverted it. That is exactly the drift this platform
 * exists to catch, so it is recorded rather than assumed away.
 */
export async function verifyChange(
  ctx: TenantContext,
  changeRequestId: string,
): Promise<{ matched: boolean; notes: string }> {
  requireCapability(ctx, 'location:view');

  const request = await ctx.db.changeRequest.findFirst({
    where: { id: changeRequestId },
    include: {
      location: {
        select: { googleLocationName: true, gbpAccount: { select: { connectionId: true } } },
      },
      executions: {
        where: { dryRun: false, status: ExecutionStatus.SUCCEEDED },
        orderBy: { attempt: 'desc' },
        take: 1,
      },
    },
  });
  if (!request) throw new NotFoundError('Change request not found.');

  const execution = request.executions[0];
  if (!execution) {
    throw new ConflictError(
      'There is no successful live execution to verify. A dry run changes nothing, so there is ' +
        'nothing for Google to have persisted.',
    );
  }

  const executor = getExecutor(request.actionType);
  const provider = getGbpProvider();
  const accessToken = await getAccessToken(
    ctx.organizationId,
    request.location.gbpAccount.connectionId,
  );

  const observed = await provider.getLocation(
    { accessToken, logContext: { organizationId: ctx.organizationId, changeRequestId } },
    request.location.googleLocationName,
  );

  const observedState = executor.captureBefore(observed);
  const expected = execution.afterState as Record<string, unknown> | null;
  const matched = stableStringify(observedState) === stableStringify(expected ?? {});

  await ctx.db.verification.create({
    data: {
      organizationId: ctx.organizationId,
      changeExecutionId: execution.id,
      matched,
      observedState: observedState as Prisma.InputJsonValue,
      notes: matched
        ? 'Observed state matches what was applied.'
        : 'Observed state differs from what was applied. The change may have been rejected or reverted.',
    },
  });

  return {
    matched,
    notes: matched
      ? 'Verified: Google is serving the applied value.'
      : 'Mismatch: Google is not serving the applied value. Re-audit this location.',
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listChangeRequests(
  ctx: TenantContext,
  filter?: { status?: ChangeRequestStatus; locationId?: string },
) {
  requireCapability(ctx, 'location:view');

  return ctx.db.changeRequest.findMany({
    where: {
      ...(filter?.status ? { status: filter.status } : {}),
      ...(filter?.locationId ? { locationId: filter.locationId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      location: { select: { id: true, title: true } },
      requestedBy: { select: { email: true, name: true } },
      approvedBy: { select: { email: true, name: true } },
      executions: { orderBy: { attempt: 'desc' }, take: 1 },
    },
  });
}

export async function getChangeLog(ctx: TenantContext, locationId: string, take = 50) {
  requireCapability(ctx, 'location:view');

  return ctx.db.changeLog.findMany({
    where: { locationId },
    orderBy: { createdAt: 'desc' },
    take,
    include: { actorUser: { select: { email: true, name: true } } },
  });
}
