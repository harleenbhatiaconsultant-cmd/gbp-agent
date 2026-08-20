/**
 * Tenant isolation.
 *
 * The Phase 1 exit criterion is "a user in org A provably cannot reach org B".
 * These tests assert the database-layer half of that guarantee now, so the
 * property is established before any feature depends on it.
 *
 * Cross-tenant reads must surface as ABSENT, not forbidden — confirming that a
 * resource exists in another tenant is itself an information leak.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/server/db/client';
import { tenantDb } from '@/server/db/tenant';
import { TenantIsolationError } from '@/server/errors';

const ORG_A = 'org_iso_a';
const ORG_B = 'org_iso_b';
const KEY_A = 'apikey_iso_a';
const KEY_B = 'apikey_iso_b';

beforeAll(async () => {
  await prisma.apiKey.deleteMany({ where: { id: { in: [KEY_A, KEY_B] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });

  await prisma.organization.createMany({
    data: [
      { id: ORG_A, name: 'Isolation A', slug: 'isolation-a' },
      { id: ORG_B, name: 'Isolation B', slug: 'isolation-b' },
    ],
  });

  await prisma.apiKey.createMany({
    data: [
      { id: KEY_A, organizationId: ORG_A, name: 'A key', keyHash: 'hash_a', prefix: 'gbpa' },
      { id: KEY_B, organizationId: ORG_B, name: 'B key', keyHash: 'hash_b', prefix: 'gbpb' },
    ],
  });
});

afterAll(async () => {
  await prisma.apiKey.deleteMany({ where: { id: { in: [KEY_A, KEY_B] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await prisma.$disconnect();
});

describe('tenantDb read scoping', () => {
  it('returns only the acting organization rows from findMany', async () => {
    const rows = await tenantDb(ORG_A).apiKey.findMany();
    expect(rows.map((r) => r.id)).toEqual([KEY_A]);
  });

  it('scopes an unfiltered count', async () => {
    expect(await tenantDb(ORG_A).apiKey.count()).toBe(1);
    expect(await tenantDb(ORG_B).apiKey.count()).toBe(1);
  });

  it('does not leak another tenant row through findFirst, even with a matching filter', async () => {
    const row = await tenantDb(ORG_A).apiKey.findFirst({ where: { id: KEY_B } });
    expect(row).toBeNull();
  });

  it('treats a cross-tenant findUnique as absent rather than forbidden', async () => {
    const row = await tenantDb(ORG_A).apiKey.findUnique({ where: { keyHash: 'hash_b' } });
    expect(row).toBeNull();
  });

  it('throws not-found for a cross-tenant findUniqueOrThrow', async () => {
    await expect(
      tenantDb(ORG_A).apiKey.findUniqueOrThrow({ where: { keyHash: 'hash_b' } }),
    ).rejects.toThrow();
  });
});

describe('tenantDb write scoping', () => {
  it('refuses to update another tenant record', async () => {
    await expect(
      tenantDb(ORG_A).apiKey.update({ where: { id: KEY_B }, data: { name: 'hijacked' } }),
    ).rejects.toThrow();

    // And the row is untouched.
    const untouched = await prisma.apiKey.findUnique({ where: { id: KEY_B } });
    expect(untouched?.name).toBe('B key');
  });

  it('refuses to delete another tenant record', async () => {
    await expect(
      tenantDb(ORG_A).apiKey.delete({ where: { id: KEY_B } }),
    ).rejects.toThrow();

    expect(await prisma.apiKey.findUnique({ where: { id: KEY_B } })).not.toBeNull();
  });

  it('does not delete another tenant rows through an unfiltered deleteMany', async () => {
    const result = await tenantDb(ORG_A).apiKey.deleteMany({ where: { name: 'B key' } });
    expect(result.count).toBe(0);
    expect(await prisma.apiKey.findUnique({ where: { id: KEY_B } })).not.toBeNull();
  });

  it('accepts a create that names the acting organization', async () => {
    const created = await tenantDb(ORG_A).apiKey.create({
      data: {
        organizationId: ORG_A,
        name: 'explicit',
        keyHash: 'hash_explicit',
        prefix: 'gbpe',
      },
    });
    expect(created.organizationId).toBe(ORG_A);
    await prisma.apiKey.delete({ where: { id: created.id } });
  });

  it('stamps ownership when the payload omits organizationId', async () => {
    // Prisma's generated types require organizationId, so services normally
    // pass it explicitly. This loose call exercises the stamping safety net
    // for any caller that does not.
    const looseDelegate = tenantDb(ORG_A).apiKey as unknown as {
      create(args: { data: Record<string, unknown> }): Promise<{
        id: string;
        organizationId: string;
      }>;
    };

    const created = await looseDelegate.create({
      data: { name: 'stamped', keyHash: 'hash_stamped', prefix: 'gbps' },
    });

    expect(created.organizationId).toBe(ORG_A);
    await prisma.apiKey.delete({ where: { id: created.id } });
  });

  it('rejects a create that names a different organization', async () => {
    await expect(
      tenantDb(ORG_A).apiKey.create({
        data: {
          organizationId: ORG_B,
          name: 'smuggled',
          keyHash: 'hash_smuggled',
          prefix: 'gbpx',
        },
      }),
    ).rejects.toBeInstanceOf(TenantIsolationError);

    expect(await prisma.apiKey.findUnique({ where: { keyHash: 'hash_smuggled' } })).toBeNull();
  });

  it('refuses upsert, which cannot be tenant-scoped safely', async () => {
    await expect(
      tenantDb(ORG_A).apiKey.upsert({
        where: { id: KEY_B },
        create: {
          organizationId: ORG_A,
          name: 'x',
          keyHash: 'hash_x',
          prefix: 'gbpx',
        },
        update: { name: 'x' },
      }),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });
});

describe('non-tenant models', () => {
  it('leaves global models unscoped (Organization is the tenant root)', async () => {
    const orgs = await tenantDb(ORG_A).organization.findMany({
      where: { id: { in: [ORG_A, ORG_B] } },
    });
    // Organization is exempt by design; callers scope it by id themselves.
    expect(orgs).toHaveLength(2);
  });
});
