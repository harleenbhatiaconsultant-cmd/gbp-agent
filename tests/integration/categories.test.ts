/**
 * Category search.
 *
 * The behaviour worth pinning is the degradation: the taxonomy sits behind API
 * access that is not approved yet, and the editor has to say WHY it cannot
 * search rather than looking broken. "Not approved yet" and "something is
 * wrong" are different messages and must stay different.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MemberRole, PlanTier } from '@/generated/prisma/enums';

vi.mock('@/server/services/connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/connections')>();
  return { ...actual, getAccessToken: vi.fn(async () => 'test-access-token') };
});

// The service refuses to search at all without OAuth configured, which would
// short-circuit every case below. Report it as configured; the provider double
// decides what actually happens.
vi.mock('@/server/services/connect-status', () => ({
  isGoogleConnectConfigured: () => true,
}));

import { prisma } from '@/server/db/client';
import { tenantDb } from '@/server/db/tenant';
import { setGbpProviderForTesting } from '@/server/integrations/google/direct-provider';
import {
  GbpPermissionError,
  GbpAuthError,
  GbpTransientError,
} from '@/server/integrations/google/errors';
import { searchCategories } from '@/server/services/categories';
import type { TenantContext } from '@/server/auth/tenant-context';
import { FakeGbpProvider } from '../fixtures/fake-gbp-provider';
import { healthyLocation } from '../fixtures/locations';

const ORG_ID = 'org_categories';
const USER_ID = 'user_categories';
const CONNECTION_ID = 'conn_categories';

let ctx: TenantContext;
let locationId: string;
let provider: FakeGbpProvider;

beforeAll(async () => {
  await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: {},
    create: { id: ORG_ID, name: 'Categories', slug: 'categories-test' },
  });
  await prisma.user.upsert({
    where: { id: USER_ID },
    update: {},
    create: { id: USER_ID, email: 'owner@categories.test' },
  });
  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: USER_ID, organizationId: ORG_ID } },
    update: { role: MemberRole.OWNER },
    create: { userId: USER_ID, organizationId: ORG_ID, role: MemberRole.OWNER },
  });
  await prisma.googleConnection.upsert({
    where: { id: CONNECTION_ID },
    update: {},
    create: {
      id: CONNECTION_ID,
      organizationId: ORG_ID,
      googleAccountEmail: 'categories@example.test',
      encryptedRefreshToken: 'v0.test.test.not-a-real-token',
      encryptionKeyVersion: 0,
      scopes: [],
    },
  });

  const account =
    (await prisma.gbpAccount.findFirst({
      where: { organizationId: ORG_ID, googleAccountName: 'accounts/categories' },
    })) ??
    (await prisma.gbpAccount.create({
      data: {
        organizationId: ORG_ID,
        connectionId: CONNECTION_ID,
        googleAccountName: 'accounts/categories',
      },
    }));

  const location = await prisma.location.create({
    data: {
      organizationId: ORG_ID,
      gbpAccountId: account.id,
      googleLocationName: `locations/categories-${Date.now()}`,
      title: 'Categories Test Location',
      address: { regionCode: 'US', locality: 'Portland' },
    },
  });
  locationId = location.id;

  ctx = {
    organizationId: ORG_ID,
    organizationSlug: 'categories-test',
    plan: PlanTier.FREE,
    userId: USER_ID,
    role: MemberRole.OWNER,
    isElevated: false,
    db: tenantDb(ORG_ID),
  };

  provider = new FakeGbpProvider(healthyLocation);
  setGbpProviderForTesting(provider);
});

afterAll(async () => {
  setGbpProviderForTesting(null);
  await prisma.$disconnect();
});

describe('searching the taxonomy', () => {
  it('returns matching categories', async () => {
    const result = await searchCategories(ctx, locationId, 'dent');

    expect(result.available).toBe(true);
    if (!result.available) return;

    const ids = result.categories.map((c) => c.id);
    expect(ids).toContain('gcid:dentist');
    expect(ids).toContain('gcid:dental_clinic');
    expect(ids).not.toContain('gcid:plumber');
  });

  it('always returns a usable display name', async () => {
    const result = await searchCategories(ctx, locationId, 'dentist');
    if (!result.available) throw new Error('expected available');

    for (const category of result.categories) {
      expect(category.displayName.length).toBeGreaterThan(0);
      expect(category.id).toMatch(/^gcid:/);
    }
  });

  it('does not call Google for a one-character query', async () => {
    provider.reset();
    const result = await searchCategories(ctx, locationId, 'd');

    expect(result).toEqual({ available: true, categories: [] });
    // A type-ahead firing on every keystroke would burn the request budget.
    expect(provider.categorySearches).toHaveLength(0);
  });

  it('uses the region from the location address', async () => {
    // The taxonomy differs by country; searching the wrong one returns
    // categories Google will then reject on write.
    const result = await searchCategories(ctx, locationId, 'dentist');
    expect(result.available).toBe(true);
  });
});

describe('degradation', () => {
  it('reports pending API access distinctly from a fault', async () => {
    provider.failNextSearchWith = new GbpPermissionError('The caller does not have permission');

    const result = await searchCategories(ctx, locationId, 'dentist');

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toMatch(/has not been approved/i);
    // It must point at the fallback rather than dead-ending.
    expect(result.reason).toMatch(/known category id/i);
  });

  it('reports a revoked connection as needing reauthorization', async () => {
    provider.failNextSearchWith = new GbpAuthError('Token has been revoked');

    const result = await searchCategories(ctx, locationId, 'dentist');

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toMatch(/reauthorized/i);
  });

  it('falls back without claiming to know why on an unexpected fault', async () => {
    provider.failNextSearchWith = new GbpTransientError('upstream 503');

    const result = await searchCategories(ctx, locationId, 'dentist');

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toMatch(/could not be reached/i);
    expect(result.reason).not.toMatch(/approved/i);
  });

  it('never throws at the caller — the editor must stay usable', async () => {
    provider.failNextSearchWith = new Error('something entirely unexpected');
    await expect(searchCategories(ctx, locationId, 'dentist')).resolves.toMatchObject({
      available: false,
    });
  });
});
