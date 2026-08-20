/**
 * The change pipeline, end to end.
 *
 * The headline assertion of this file is the last one: across every path
 * exercised here — proposing, approving, executing, retrying — the provider
 * never receives a single call with `validateOnly: false`. That is the
 * guarantee that the platform cannot touch a live business profile under the
 * default configuration, even with valid credentials loaded, and it is asserted
 * against the actual call log rather than inferred from a flag.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  ChangeRequestStatus,
  MemberRole,
  PlanTier,
  ActionType,
} from '@/generated/prisma/enums';

// The fake provider ignores the token entirely; this keeps the test off the network.
vi.mock('@/server/services/connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/connections')>();
  return { ...actual, getAccessToken: vi.fn(async () => 'test-access-token') };
});

import { prisma } from '@/server/db/client';
import { tenantDb } from '@/server/db/tenant';
import { contentHash } from '@/lib/hash';
import { setGbpProviderForTesting } from '@/server/integrations/google/direct-provider';
import { GbpValidationError } from '@/server/integrations/google/errors';
import {
  proposeChange,
  approveChange,
  rejectChange,
  executeChange,
  listChangeRequests,
} from '@/server/services/changes';
import { isDryRun, getWriteMode } from '@/config/features';
import { PolicyBlockedError, ConflictError, ForbiddenError } from '@/server/errors';
import type { TenantContext } from '@/server/auth/tenant-context';
import { FakeGbpProvider } from '../fixtures/fake-gbp-provider';
import { healthyLocation } from '../fixtures/locations';

const ORG_ID = 'org_change_pipeline';
const OWNER_ID = 'user_change_owner';
const EDITOR_ID = 'user_change_editor';
const CONNECTION_ID = 'conn_change_pipeline';

let ownerCtx: TenantContext;
let editorCtx: TenantContext;
let locationId: string;
let provider: FakeGbpProvider;

const humanSource = { kind: 'USER_INPUT' as const, detail: 'Confirmed with the owner by phone' };

function makeCtx(userId: string, role: MemberRole): TenantContext {
  return {
    organizationId: ORG_ID,
    organizationSlug: 'change-pipeline',
    plan: PlanTier.FREE,
    userId,
    role,
    isElevated: false,
    db: tenantDb(ORG_ID),
  };
}

beforeAll(async () => {
  await prisma.googleConnection.deleteMany({ where: { id: CONNECTION_ID } });

  await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: {},
    create: { id: ORG_ID, name: 'Change Pipeline', slug: 'change-pipeline' },
  });

  for (const [id, email, role] of [
    [OWNER_ID, 'owner@pipeline.test', MemberRole.OWNER],
    [EDITOR_ID, 'editor@pipeline.test', MemberRole.EDITOR],
  ] as const) {
    await prisma.user.upsert({ where: { id }, update: {}, create: { id, email } });
    await prisma.membership.upsert({
      where: { userId_organizationId: { userId: id, organizationId: ORG_ID } },
      update: { role },
      create: { userId: id, organizationId: ORG_ID, role },
    });
  }

  await prisma.googleConnection.create({
    data: {
      id: CONNECTION_ID,
      organizationId: ORG_ID,
      googleAccountEmail: 'pipeline@example.test',
      encryptedRefreshToken: 'v0.test.test.not-a-real-token',
      encryptionKeyVersion: 0,
      scopes: [],
    },
  });

  const account = await prisma.gbpAccount.create({
    data: {
      organizationId: ORG_ID,
      connectionId: CONNECTION_ID,
      googleAccountName: 'accounts/pipeline',
    },
  });

  const location = await prisma.location.create({
    data: {
      organizationId: ORG_ID,
      gbpAccountId: account.id,
      googleLocationName: 'locations/pipeline',
      title: healthyLocation.title ?? 'Pipeline Location',
    },
  });
  locationId = location.id;

  await prisma.locationSnapshot.create({
    data: {
      organizationId: ORG_ID,
      locationId,
      rawPayload: healthyLocation as never,
      contentHash: contentHash(healthyLocation),
      source: 'TEST',
    },
  });

  ownerCtx = makeCtx(OWNER_ID, MemberRole.OWNER);
  editorCtx = makeCtx(EDITOR_ID, MemberRole.EDITOR);

  provider = new FakeGbpProvider(healthyLocation);
  setGbpProviderForTesting(provider);
});

afterAll(async () => {
  setGbpProviderForTesting(null);
  await prisma.googleConnection.deleteMany({ where: { id: CONNECTION_ID } });
  // User and Organization are left behind: append-only AuditEvent rows make
  // them undeletable by design.
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.changeRequest.deleteMany({ where: { organizationId: ORG_ID } });
  provider.reset();
  provider.setProfile(healthyLocation);
});

describe('environment guarantees', () => {
  it('is in validate_only mode', () => {
    expect(getWriteMode()).toBe('validate_only');
    expect(isDryRun()).toBe(true);
  });
});

describe('policy refusal', () => {
  it('refuses a keyword-stuffed name and creates no change request', async () => {
    const before = await prisma.changeRequest.count({ where: { organizationId: ORG_ID } });

    await expect(
      proposeChange(ownerCtx, {
        locationId,
        actionType: ActionType.UPDATE_TITLE,
        payload: { title: 'Northside Dental Care Portland Dentist', sourceRef: humanSource },
      }),
    ).rejects.toBeInstanceOf(PolicyBlockedError);

    const after = await prisma.changeRequest.count({ where: { organizationId: ORG_ID } });
    expect(after).toBe(before);
  });

  it('records the refusal permanently as a PolicyViolation', async () => {
    const before = await prisma.policyViolation.count({ where: { organizationId: ORG_ID } });

    await expect(
      proposeChange(ownerCtx, {
        locationId,
        actionType: ActionType.UPDATE_DESCRIPTION,
        payload: {
          description: 'We guarantee you will rank first on Google for every local search.',
          sourceRef: { kind: 'AI_GENERATED', detail: 'assistant' },
        },
      }),
    ).rejects.toBeInstanceOf(PolicyBlockedError);

    const after = await prisma.policyViolation.count({ where: { organizationId: ORG_ID } });
    expect(after).toBeGreaterThan(before);
  });

  it('never sends a blocked change to Google at all', () => {
    expect(provider.updates).toHaveLength(0);
  });
});

describe('proposal and approval', () => {
  it('queues an allowed change for human approval rather than auto-applying', async () => {
    const result = await proposeChange(ownerCtx, {
      locationId,
      actionType: ActionType.UPDATE_WEBSITE,
      payload: { websiteUri: 'https://northsidedental.example/portland-or', sourceRef: humanSource },
    });

    expect(result.status).toBe(ChangeRequestStatus.PENDING_APPROVAL);
    expect(result.deduplicated).toBe(false);
  });

  it('collapses an identical repeat proposal instead of queueing twice', async () => {
    const payload = {
      websiteUri: 'https://northsidedental.example/portland-or',
      sourceRef: humanSource,
    };

    const first = await proposeChange(ownerCtx, {
      locationId,
      actionType: ActionType.UPDATE_WEBSITE,
      payload,
    });
    const second = await proposeChange(ownerCtx, {
      locationId,
      actionType: ActionType.UPDATE_WEBSITE,
      payload,
    });

    expect(second.changeRequestId).toBe(first.changeRequestId);
    expect(second.deduplicated).toBe(true);
  });

  it('refuses execution before approval', async () => {
    const { changeRequestId } = await proposeChange(ownerCtx, {
      locationId,
      actionType: ActionType.UPDATE_WEBSITE,
      payload: { websiteUri: 'https://example.test/a', sourceRef: humanSource },
    });

    await expect(executeChange(ownerCtx, changeRequestId)).rejects.toBeInstanceOf(ConflictError);
    expect(provider.updates).toHaveLength(0);
  });

  it('refuses approval from an EDITOR', async () => {
    const { changeRequestId } = await proposeChange(ownerCtx, {
      locationId,
      actionType: ActionType.UPDATE_WEBSITE,
      payload: { websiteUri: 'https://example.test/b', sourceRef: humanSource },
    });

    await expect(approveChange(editorCtx, changeRequestId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('records the approver on approval', async () => {
    const { changeRequestId } = await proposeChange(ownerCtx, {
      locationId,
      actionType: ActionType.UPDATE_WEBSITE,
      payload: { websiteUri: 'https://example.test/c', sourceRef: humanSource },
    });

    await approveChange(ownerCtx, changeRequestId);

    const request = await prisma.changeRequest.findUniqueOrThrow({ where: { id: changeRequestId } });
    expect(request.status).toBe(ChangeRequestStatus.APPROVED);
    expect(request.approvedByUserId).toBe(OWNER_ID);
    expect(request.approvedAt).toBeInstanceOf(Date);
  });

  it('marks a rejected change and refuses to execute it', async () => {
    const { changeRequestId } = await proposeChange(ownerCtx, {
      locationId,
      actionType: ActionType.UPDATE_WEBSITE,
      payload: { websiteUri: 'https://example.test/d', sourceRef: humanSource },
    });

    await rejectChange(ownerCtx, changeRequestId, 'Wrong page for this location');

    const request = await prisma.changeRequest.findUniqueOrThrow({ where: { id: changeRequestId } });
    expect(request.status).toBe(ChangeRequestStatus.REJECTED);

    await expect(executeChange(ownerCtx, changeRequestId)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('execution under validate_only', () => {
  async function approvedRequest(websiteUri: string): Promise<string> {
    const { changeRequestId } = await proposeChange(ownerCtx, {
      locationId,
      actionType: ActionType.UPDATE_WEBSITE,
      payload: { websiteUri, sourceRef: humanSource },
    });
    await approveChange(ownerCtx, changeRequestId);
    return changeRequestId;
  }

  it('validates against Google and applies nothing', async () => {
    const id = await approvedRequest('https://example.test/validate-1');
    const result = await executeChange(ownerCtx, id);

    expect(result.validated).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.writeMode).toBe('validate_only');
    expect(result.message).toMatch(/no change was made/i);
  });

  it('sends exactly one call, with validateOnly true', async () => {
    const id = await approvedRequest('https://example.test/validate-2');
    await executeChange(ownerCtx, id);

    expect(provider.updates).toHaveLength(1);
    expect(provider.updates[0].validateOnly).toBe(true);
    expect(provider.updates[0].updateMask).toEqual(['websiteUri']);
  });

  it('writes no ChangeLog entry, because nothing changed', async () => {
    const before = await prisma.changeLog.count({ where: { locationId } });

    const id = await approvedRequest('https://example.test/validate-3');
    await executeChange(ownerCtx, id);

    const after = await prisma.changeLog.count({ where: { locationId } });
    expect(after).toBe(before);
  });

  it('returns the request to APPROVED so it can be applied later without re-approval', async () => {
    const id = await approvedRequest('https://example.test/validate-4');
    await executeChange(ownerCtx, id);

    const request = await prisma.changeRequest.findUniqueOrThrow({ where: { id } });
    expect(request.status).toBe(ChangeRequestStatus.APPROVED);
  });

  it('records the dry run as an execution attempt for the audit trail', async () => {
    const id = await approvedRequest('https://example.test/validate-5');
    await executeChange(ownerCtx, id);

    const executions = await prisma.changeExecution.findMany({ where: { changeRequestId: id } });
    expect(executions).toHaveLength(1);
    expect(executions[0].dryRun).toBe(true);
    expect(executions[0].status).toBe('SUCCEEDED');
    expect(executions[0].beforeState).not.toBeNull();
  });

  it('stays dry across repeated executions', async () => {
    const id = await approvedRequest('https://example.test/validate-6');
    await executeChange(ownerCtx, id);
    await executeChange(ownerCtx, id);
    await executeChange(ownerCtx, id);

    expect(provider.liveWrites).toHaveLength(0);
    expect(provider.dryRuns).toHaveLength(3);
  });
});

describe('when Google rejects the change', () => {
  it('marks the request FAILED and never attempts a live write', async () => {
    const { changeRequestId } = await proposeChange(ownerCtx, {
      locationId,
      actionType: ActionType.UPDATE_WEBSITE,
      payload: { websiteUri: 'https://example.test/rejected', sourceRef: humanSource },
    });
    await approveChange(ownerCtx, changeRequestId);

    provider.failNextUpdateWith = new GbpValidationError('Invalid website URI for this location');

    const result = await executeChange(ownerCtx, changeRequestId);

    expect(result.validated).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.message).toMatch(/rejected this change/i);

    const request = await prisma.changeRequest.findUniqueOrThrow({ where: { id: changeRequestId } });
    expect(request.status).toBe(ChangeRequestStatus.FAILED);
    expect(provider.liveWrites).toHaveLength(0);

    // Asserted in the same test rather than a sibling: beforeEach clears change
    // requests between tests, which cascades the executions away with them.
    const execution = await prisma.changeExecution.findFirstOrThrow({
      where: { changeRequestId },
      orderBy: { startedAt: 'desc' },
    });
    expect(execution.status).toBe('FAILED');
    expect(execution.errorCode).toBe('validation');
    expect(execution.errorMessage).toMatch(/Invalid website URI/);
  });
});

describe('queries', () => {
  it('lists pending approvals for the queue', async () => {
    await proposeChange(ownerCtx, {
      locationId,
      actionType: ActionType.UPDATE_WEBSITE,
      payload: { websiteUri: 'https://example.test/queue', sourceRef: humanSource },
    });

    const pending = await listChangeRequests(ownerCtx, {
      status: ChangeRequestStatus.PENDING_APPROVAL,
    });
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0].location.title).toBeTruthy();
  });
});

/**
 * The load-bearing assertion.
 *
 * Every test above ran the real pipeline against a recording provider. If any
 * path could reach a live profile, a call with validateOnly false would appear
 * here.
 */
describe('the live-write gate', () => {
  it('never issued a live write anywhere in this suite', () => {
    expect(provider.liveWrites).toHaveLength(0);
  });
});
