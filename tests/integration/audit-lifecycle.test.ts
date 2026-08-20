/**
 * Finding lifecycle across repeated audits.
 *
 * The client-facing promise is "here is what was wrong, and here is when it got
 * fixed". That only holds if repeated audits track the same issue rather than
 * re-creating it, and if RESOLVED means genuinely fixed.
 *
 * These tests pin both properties:
 *   - running the audit repeatedly leaves exactly one OPEN row per issue
 *   - re-observing an issue marks the prior row SUPERSEDED, never RESOLVED
 *   - fixing the profile is what produces RESOLVED
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MemberRole, PlanTier, FindingStatus } from '@/generated/prisma/enums';
import { prisma } from '@/server/db/client';
import { tenantDb } from '@/server/db/tenant';
import { contentHash } from '@/lib/hash';
import { runLocationAudit } from '@/server/services/audits';
import type { TenantContext } from '@/server/auth/tenant-context';
import { healthyLocation, neglectedLocation } from '../fixtures/locations';

const ORG_ID = 'org_audit_lifecycle';
const USER_ID = 'user_audit_lifecycle';
const CONNECTION_ID = 'conn_audit_lifecycle';

let ctx: TenantContext;
let locationId: string;

async function addSnapshot(payload: unknown) {
  await prisma.locationSnapshot.create({
    data: {
      organizationId: ORG_ID,
      locationId,
      rawPayload: payload as never,
      contentHash: contentHash(payload),
      source: 'TEST',
    },
  });
}

beforeAll(async () => {
  // Deleting the connection cascades through accounts, locations, snapshots,
  // audit runs and findings — everything this test creates.
  //
  // The User and Organization are upserted rather than recreated: after the
  // first run they carry append-only AuditEvent rows, which makes them
  // undeletable by design (see the note in afterAll).
  await prisma.googleConnection.deleteMany({ where: { id: CONNECTION_ID } });

  await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: {},
    create: { id: ORG_ID, name: 'Audit Lifecycle', slug: 'audit-lifecycle' },
  });

  await prisma.user.upsert({
    where: { id: USER_ID },
    update: {},
    create: { id: USER_ID, email: 'lifecycle@example.test', name: 'Lifecycle' },
  });

  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: USER_ID, organizationId: ORG_ID } },
    update: { role: MemberRole.OWNER },
    create: { userId: USER_ID, organizationId: ORG_ID, role: MemberRole.OWNER },
  });

  await prisma.googleConnection.create({
    data: {
      id: CONNECTION_ID,
      organizationId: ORG_ID,
      googleAccountEmail: 'lifecycle@example.test',
      encryptedRefreshToken: 'v0.test.test.not-a-real-token',
      encryptionKeyVersion: 0,
      scopes: [],
    },
  });

  const account = await prisma.gbpAccount.create({
    data: {
      organizationId: ORG_ID,
      connectionId: CONNECTION_ID,
      googleAccountName: 'accounts/lifecycle',
    },
  });

  const location = await prisma.location.create({
    data: {
      organizationId: ORG_ID,
      gbpAccountId: account.id,
      googleLocationName: 'locations/lifecycle',
      title: 'Lifecycle Test Location',
    },
  });
  locationId = location.id;

  ctx = {
    organizationId: ORG_ID,
    organizationSlug: 'audit-lifecycle',
    plan: PlanTier.FREE,
    userId: USER_ID,
    role: MemberRole.OWNER,
    isElevated: false,
    db: tenantDb(ORG_ID),
  };

  await addSnapshot(neglectedLocation);
});

afterAll(async () => {
  await prisma.googleConnection.deleteMany({ where: { id: CONNECTION_ID } });

  // The User, Membership and Organization are deliberately left behind.
  //
  // Both are referenced by append-only AuditEvent rows. Deleting the user would
  // cascade `actorUserId` to NULL — an UPDATE, which the append-only trigger
  // correctly refuses. That is the intended behaviour, not a test workaround:
  // attribution in the compliance trail must not evaporate. Erasing a person
  // means anonymising their User row, never deleting it.
  await prisma.$disconnect();
});

describe('first audit', () => {
  it('opens findings for a neglected profile', async () => {
    const summary = await runLocationAudit(ctx, locationId);

    expect(summary.findingsOpened).toBeGreaterThan(5);
    expect(summary.findingsCarriedOver).toBe(0);
    expect(summary.findingsResolved).toBe(0);
    expect(summary.health.score).not.toBeNull();
    expect(summary.health.score!).toBeLessThan(40);
  });

  it('records the score on the location for listing', async () => {
    const location = await prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    expect(location.healthScore).not.toBeNull();
    expect(location.lastAuditAt).not.toBeNull();
  });
});

describe('repeated audits with no change', () => {
  it('carries findings over instead of opening duplicates', async () => {
    const before = await prisma.auditFinding.count({
      where: { locationId, status: FindingStatus.OPEN },
    });

    const summary = await runLocationAudit(ctx, locationId);

    expect(summary.findingsOpened).toBe(0);
    expect(summary.findingsCarriedOver).toBe(before);

    const after = await prisma.auditFinding.count({
      where: { locationId, status: FindingStatus.OPEN },
    });
    expect(after).toBe(before);
  });

  it('marks the prior observation SUPERSEDED, never RESOLVED', async () => {
    await runLocationAudit(ctx, locationId);

    const superseded = await prisma.auditFinding.count({
      where: { locationId, status: FindingStatus.SUPERSEDED },
    });
    const resolved = await prisma.auditFinding.count({
      where: { locationId, status: FindingStatus.RESOLVED },
    });

    expect(superseded).toBeGreaterThan(0);
    // Nothing was fixed, so nothing may be reported as resolved.
    expect(resolved).toBe(0);
  });
});

describe('after the profile is fixed', () => {
  it('resolves the findings that no longer apply', async () => {
    const openBefore = await prisma.auditFinding.count({
      where: { locationId, status: FindingStatus.OPEN },
    });
    expect(openBefore).toBeGreaterThan(0);

    // A new snapshot representing a repaired profile.
    await addSnapshot({ ...healthyLocation, name: 'locations/lifecycle' });

    const summary = await runLocationAudit(ctx, locationId);

    expect(summary.findingsResolved).toBe(openBefore);
    expect(summary.health.score).toBe(100);

    const stillOpen = await prisma.auditFinding.count({
      where: { locationId, status: FindingStatus.OPEN },
    });
    expect(stillOpen).toBe(0);

    const resolved = await prisma.auditFinding.count({
      where: { locationId, status: FindingStatus.RESOLVED },
    });
    expect(resolved).toBe(openBefore);
  });

  it('stamps resolvedAt so the fix has a date', async () => {
    const resolved = await prisma.auditFinding.findFirst({
      where: { locationId, status: FindingStatus.RESOLVED },
    });
    expect(resolved?.resolvedAt).toBeInstanceOf(Date);
  });
});
