/**
 * The live write path.
 *
 * Its sibling file proves the platform never reaches a live profile under the
 * default configuration. That is only half the story: it would also be true of
 * a write path that was simply broken. This file forces the gate open — by
 * stubbing `isDryRun`, the single function that decides — and checks that what
 * lies beyond it is correct.
 *
 * The gate itself is NOT stubbed anywhere in the application: `GBP_WRITE_MODE`
 * still refuses `live` outside production, and this override exists only inside
 * this test module. What it demonstrates is that when the switch is eventually
 * flipped deliberately, the behaviour behind it is known rather than assumed:
 *
 *   - a dry run still runs FIRST, every time
 *   - the ChangeLog entry and the status transition share one transaction
 *   - a retry never double-applies
 *   - verification catches a value Google did not actually persist
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ChangeRequestStatus, MemberRole, PlanTier, ActionType } from '@/generated/prisma/enums';

vi.mock('@/server/services/connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/connections')>();
  return { ...actual, getAccessToken: vi.fn(async () => 'test-access-token') };
});

// Force the live-write gate open for this module only.
vi.mock('@/config/features', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/features')>();
  return {
    ...actual,
    isDryRun: () => false,
    getWriteMode: () => 'live' as const,
  };
});

import { prisma } from '@/server/db/client';
import { tenantDb } from '@/server/db/tenant';
import { contentHash } from '@/lib/hash';
import { setGbpProviderForTesting } from '@/server/integrations/google/direct-provider';
import { proposeChange, approveChange, executeChange, verifyChange } from '@/server/services/changes';
import type { TenantContext } from '@/server/auth/tenant-context';
import { FakeGbpProvider } from '../fixtures/fake-gbp-provider';
import { healthyLocation } from '../fixtures/locations';

const ORG_ID = 'org_live_write';
const OWNER_ID = 'user_live_owner';
const CONNECTION_ID = 'conn_live_write';

let ctx: TenantContext;
let locationId: string;
let provider: FakeGbpProvider;

const humanSource = { kind: 'USER_INPUT' as const, detail: 'Confirmed with the owner' };

/**
 * This suite is ADDITIVE — it never deletes anything.
 *
 * Once a live execution writes a ChangeLog row, the connection, account and
 * location above it can no longer be deleted: the cascade would reach an
 * append-only table and the database refuses it. That is the design working,
 * so the fixtures are upserted and left in place rather than torn down.
 */
beforeAll(async () => {
  await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: {},
    create: { id: ORG_ID, name: 'Live Write', slug: 'live-write' },
  });
  await prisma.user.upsert({
    where: { id: OWNER_ID },
    update: {},
    create: { id: OWNER_ID, email: 'owner@livewrite.test' },
  });
  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: OWNER_ID, organizationId: ORG_ID } },
    update: { role: MemberRole.OWNER },
    create: { userId: OWNER_ID, organizationId: ORG_ID, role: MemberRole.OWNER },
  });

  await prisma.googleConnection.upsert({
    where: { id: CONNECTION_ID },
    update: {},
    create: {
      id: CONNECTION_ID,
      organizationId: ORG_ID,
      googleAccountEmail: 'live@example.test',
      encryptedRefreshToken: 'v0.test.test.not-a-real-token',
      encryptionKeyVersion: 0,
      scopes: [],
    },
  });

  const existingAccount = await prisma.gbpAccount.findFirst({
    where: { organizationId: ORG_ID, googleAccountName: 'accounts/live' },
  });
  if (!existingAccount) {
    await prisma.gbpAccount.create({
      data: {
        organizationId: ORG_ID,
        connectionId: CONNECTION_ID,
        googleAccountName: 'accounts/live',
      },
    });
  }

  ctx = {
    organizationId: ORG_ID,
    organizationSlug: 'live-write',
    plan: PlanTier.FREE,
    userId: OWNER_ID,
    role: MemberRole.OWNER,
    isElevated: false,
    db: tenantDb(ORG_ID),
  };

  provider = new FakeGbpProvider(healthyLocation);
  setGbpProviderForTesting(provider);
});

afterAll(async () => {
  setGbpProviderForTesting(null);
  // Nothing is deleted — see the note on beforeAll.
  await prisma.$disconnect();
});

/**
 * Each test gets its own location rather than a shared one that is cleared
 * between tests.
 *
 * Two reasons, both consequences of the append-only design working correctly:
 * a ChangeLog row cannot be deleted, and deleting the Location it belongs to
 * would cascade into it. Fresh locations also keep the blast-radius counter
 * (changes applied to THIS location today) at zero, so tests do not interfere
 * with each other or with previous runs of the suite.
 */
beforeEach(async () => {
  const account = await prisma.gbpAccount.findFirstOrThrow({
    where: { organizationId: ORG_ID },
  });

  const location = await prisma.location.create({
    data: {
      organizationId: ORG_ID,
      gbpAccountId: account.id,
      googleLocationName: `locations/live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: 'Live Write Location',
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

  provider.reset();
  provider.setProfile(healthyLocation);
});

async function approvedWebsiteChange(websiteUri: string): Promise<string> {
  const { changeRequestId } = await proposeChange(ctx, {
    locationId,
    actionType: ActionType.UPDATE_WEBSITE,
    payload: { websiteUri, sourceRef: humanSource },
  });
  await approveChange(ctx, changeRequestId);
  return changeRequestId;
}

describe('live execution', () => {
  it('dry-runs first, then applies — in that order', async () => {
    const id = await approvedWebsiteChange('https://example.test/live-1');
    const result = await executeChange(ctx, id);

    expect(result.applied).toBe(true);
    expect(provider.updates).toHaveLength(2);
    // The rehearsal must precede the real thing, never the reverse.
    expect(provider.updates[0].validateOnly).toBe(true);
    expect(provider.updates[1].validateOnly).toBe(false);
  });

  it('marks the request EXECUTED', async () => {
    const id = await approvedWebsiteChange('https://example.test/live-2');
    await executeChange(ctx, id);

    const request = await prisma.changeRequest.findUniqueOrThrow({ where: { id } });
    expect(request.status).toBe(ChangeRequestStatus.EXECUTED);
  });

  it('writes a client-facing ChangeLog entry with before and after state', async () => {
    const id = await approvedWebsiteChange('https://example.test/live-3');
    await executeChange(ctx, id);

    const entry = await prisma.changeLog.findFirstOrThrow({
      where: { changeRequestId: id },
    });

    expect(entry.actionType).toBe(ActionType.UPDATE_WEBSITE);
    expect(entry.summary).toMatch(/website/i);
    expect(entry.beforeState).toMatchObject({ websiteUri: healthyLocation.websiteUri });
    expect(entry.afterState).toMatchObject({ websiteUri: 'https://example.test/live-3' });
    expect(entry.actorUserId).toBe(OWNER_ID);
  });

  it('does not double-apply on a retry', async () => {
    const id = await approvedWebsiteChange('https://example.test/live-4');
    await executeChange(ctx, id);

    const liveWritesAfterFirst = provider.liveWrites.length;
    const retry = await executeChange(ctx, id);

    expect(retry.message).toMatch(/already executed/i);
    expect(provider.liveWrites).toHaveLength(liveWritesAfterFirst);

    const logEntries = await prisma.changeLog.count({ where: { changeRequestId: id } });
    expect(logEntries).toBe(1);
  });

  it('records both attempts as separate executions', async () => {
    const id = await approvedWebsiteChange('https://example.test/live-5');
    await executeChange(ctx, id);

    const executions = await prisma.changeExecution.findMany({
      where: { changeRequestId: id },
      orderBy: { attempt: 'asc' },
    });

    expect(executions).toHaveLength(2);
    expect(executions[0].dryRun).toBe(true);
    expect(executions[1].dryRun).toBe(false);
    expect(executions[1].afterState).not.toBeNull();
  });
});

describe('verification', () => {
  it('confirms a value Google is actually serving', async () => {
    const id = await approvedWebsiteChange('https://example.test/verify-ok');
    await executeChange(ctx, id);

    const result = await verifyChange(ctx, id);

    expect(result.matched).toBe(true);
    const verification = await prisma.verification.findFirstOrThrow({
      where: { organizationId: ORG_ID },
      orderBy: { verifiedAt: 'desc' },
    });
    expect(verification.matched).toBe(true);
  });

  it('catches a change Google silently reverted', async () => {
    const id = await approvedWebsiteChange('https://example.test/verify-drift');
    await executeChange(ctx, id);

    // Simulate Google reverting the edit, or another editor overwriting it.
    provider.setProfile({ ...healthyLocation, websiteUri: 'https://something-else.example' });

    const result = await verifyChange(ctx, id);

    expect(result.matched).toBe(false);
    expect(result.notes).toMatch(/mismatch/i);
  });

  it('refuses to verify a change that was only ever dry-run', async () => {
    const { changeRequestId } = await proposeChange(ctx, {
      locationId,
      actionType: ActionType.UPDATE_WEBSITE,
      payload: { websiteUri: 'https://example.test/never-applied', sourceRef: humanSource },
    });
    await approveChange(ctx, changeRequestId);

    // Not executed: there is no live execution to verify against.
    await expect(verifyChange(ctx, changeRequestId)).rejects.toThrowError(/no successful live execution/i);
  });
});

describe('policy still applies with the gate open', () => {
  it('refuses a keyword-stuffed name even in live mode', async () => {
    await expect(
      proposeChange(ctx, {
        locationId,
        actionType: ActionType.UPDATE_TITLE,
        payload: { title: 'Northside Dental Care Portland Dentist', sourceRef: humanSource },
      }),
    ).rejects.toThrowError();

    expect(provider.liveWrites).toHaveLength(0);
  });
});
