/**
 * Location import and snapshotting.
 *
 * The invariant that makes audits defensible: `LocationSnapshot` is an
 * immutable record of exactly what Google returned, and a new snapshot is
 * written only when the content hash actually changes. Audits run against
 * snapshots, so a score from three months ago can be recomputed and explained.
 *
 * The denormalised `Location` row exists for querying and display; the snapshot
 * is the source of truth.
 */

import type { Prisma } from '@/generated/prisma/client';
import { SyncStatus, VerificationState } from '@/generated/prisma/enums';
import { prisma } from '@/server/db';
import { requireCapability } from '@/server/auth/rbac';
import type { TenantContext } from '@/server/auth/tenant-context';
import { NotFoundError } from '@/server/errors';
import { contentHash } from '@/lib/hash';
import { childLogger } from '@/server/observability/logger';
import { recordAuditEvent } from '@/server/services/audit-events';
import { getAccessToken } from '@/server/services/connections';
import { getGbpProvider } from '@/server/integrations/google/direct-provider';
import { isGbpError } from '@/server/integrations/google/errors';
import type {
  GbpAccountResource,
  GbpLocationResource,
} from '@/server/integrations/google/types';

export interface SyncResult {
  accountsImported: number;
  locationsImported: number;
  locationsUpdated: number;
  snapshotsCreated: number;
  /** Locations whose content hash was unchanged since the previous snapshot. */
  locationsUnchanged: number;
}

function mapVerificationState(raw: string | undefined): VerificationState {
  switch (raw) {
    case 'VERIFIED':
      return VerificationState.VERIFIED;
    case 'UNVERIFIED':
      return VerificationState.UNVERIFIED;
    case 'PENDING':
    case 'PENDING_VERIFICATION':
      return VerificationState.PENDING;
    case 'SUSPENDED':
      return VerificationState.SUSPENDED;
    default:
      return VerificationState.UNKNOWN;
  }
}

/** Projects a Google location resource onto the denormalised Location columns. */
function toLocationColumns(resource: GbpLocationResource) {
  const openStatus = resource.openInfo?.status;

  return {
    title: resource.title ?? '(untitled)',
    storeCode: resource.storeCode ?? null,
    primaryCategoryId: resource.categories?.primaryCategory?.name ?? null,
    primaryCategoryName: resource.categories?.primaryCategory?.displayName ?? null,
    secondaryCategories: (resource.categories?.additionalCategories ??
      []) as unknown as Prisma.InputJsonValue,
    address: (resource.storefrontAddress ?? {}) as Prisma.InputJsonValue,
    latitude: resource.latlng?.latitude ?? null,
    longitude: resource.latlng?.longitude ?? null,
    phone: resource.phoneNumbers?.primaryPhone ?? null,
    additionalPhones: resource.phoneNumbers?.additionalPhones ?? [],
    websiteUri: resource.websiteUri ?? null,
    regularHours: (resource.regularHours ?? {}) as Prisma.InputJsonValue,
    specialHours: (resource.specialHours ?? {}) as Prisma.InputJsonValue,
    moreHours: (resource.moreHours ?? []) as Prisma.InputJsonValue,
    serviceArea: (resource.serviceArea ?? {}) as Prisma.InputJsonValue,
    profileDescription: resource.profile?.description ?? null,
    openInfo: (resource.openInfo ?? {}) as Prisma.InputJsonValue,
    labels: resource.labels ?? [],
    // The Business Information API does not return verification state; it comes
    // from the Verifications API. Suspension is inferable from openInfo.
    isSuspended: openStatus === 'CLOSED_PERMANENTLY' ? false : openStatus === 'SUSPENDED',
    lastSyncedAt: new Date(),
    syncStatus: SyncStatus.SYNCED,
    syncError: null,
  };
}

/**
 * Imports every account and location reachable through a connection.
 *
 * Idempotent: re-running updates existing rows in place and writes a snapshot
 * only where content changed.
 */
export async function syncConnection(
  ctx: TenantContext,
  connectionId: string,
): Promise<SyncResult> {
  requireCapability(ctx, 'location:sync');

  const connection = await ctx.db.googleConnection.findFirst({ where: { id: connectionId } });
  if (!connection) throw new NotFoundError('Google connection not found.');

  const log = childLogger({ organizationId: ctx.organizationId, connectionId });
  const provider = getGbpProvider();
  const accessToken = await getAccessToken(ctx.organizationId, connectionId);
  const providerCtx = {
    accessToken,
    logContext: { organizationId: ctx.organizationId, connectionId },
  };

  const result: SyncResult = {
    accountsImported: 0,
    locationsImported: 0,
    locationsUpdated: 0,
    snapshotsCreated: 0,
    locationsUnchanged: 0,
  };

  let accounts: GbpAccountResource[];
  try {
    accounts = await provider.listAccounts(providerCtx);
  } catch (error) {
    await markConnectionSyncFailure(connectionId, error);
    throw error;
  }

  for (const account of accounts) {
    const gbpAccount = await upsertGbpAccount(ctx, connectionId, account);
    result.accountsImported += 1;

    let locations: GbpLocationResource[];
    try {
      locations = await provider.listLocations(providerCtx, account.name);
    } catch (error) {
      // One inaccessible account must not abort the whole sync — a user may
      // administer several accounts with differing permissions.
      if (isGbpError(error) && (error.kind === 'permission' || error.kind === 'not_found')) {
        log.warn(
          { accountName: account.name, kind: error.kind },
          'Skipping account the connection cannot read',
        );
        continue;
      }
      await markConnectionSyncFailure(connectionId, error);
      throw error;
    }

    for (const resource of locations) {
      const outcome = await upsertLocation(ctx, gbpAccount.id, resource);
      if (outcome.created) result.locationsImported += 1;
      else result.locationsUpdated += 1;
      if (outcome.snapshotCreated) result.snapshotsCreated += 1;
      else result.locationsUnchanged += 1;
    }
  }

  await prisma.googleConnection.update({
    where: { id: connectionId },
    data: { lastSyncedAt: new Date(), lastError: null },
  });

  await recordAuditEvent({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'location.imported',
    subjectType: 'GoogleConnection',
    subjectId: connectionId,
    metadata: { ...result },
  });

  log.info({ ...result }, 'Connection sync complete');
  return result;
}

async function markConnectionSyncFailure(connectionId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : 'Sync failed';
  await prisma.googleConnection
    .update({ where: { id: connectionId }, data: { lastError: message.slice(0, 500) } })
    .catch(() => undefined);
}

async function upsertGbpAccount(
  ctx: TenantContext,
  connectionId: string,
  account: GbpAccountResource,
): Promise<{ id: string }> {
  const existing = await ctx.db.gbpAccount.findFirst({
    where: { googleAccountName: account.name },
  });

  const data = {
    accountName: account.accountName ?? null,
    accountType: account.type ?? null,
    role: account.role ?? null,
    verificationState: mapVerificationState(account.verificationState),
  };

  if (existing) {
    await ctx.db.gbpAccount.update({ where: { id: existing.id }, data });
    return { id: existing.id };
  }

  const created = await ctx.db.gbpAccount.create({
    data: {
      organizationId: ctx.organizationId,
      connectionId,
      googleAccountName: account.name,
      ...data,
    },
  });
  return { id: created.id };
}

interface UpsertLocationOutcome {
  locationId: string;
  created: boolean;
  snapshotCreated: boolean;
}

async function upsertLocation(
  ctx: TenantContext,
  gbpAccountId: string,
  resource: GbpLocationResource,
): Promise<UpsertLocationOutcome> {
  const columns = toLocationColumns(resource);
  const hash = contentHash(resource);

  const existing = await ctx.db.location.findFirst({
    where: { googleLocationName: resource.name },
    select: { id: true },
  });

  const locationId = existing
    ? (await ctx.db.location.update({ where: { id: existing.id }, data: columns })).id
    : (
        await ctx.db.location.create({
          data: {
            organizationId: ctx.organizationId,
            gbpAccountId,
            googleLocationName: resource.name,
            ...columns,
          },
        })
      ).id;

  // Only write a snapshot when the content actually differs from the newest one.
  const latest = await ctx.db.locationSnapshot.findFirst({
    where: { locationId },
    orderBy: { capturedAt: 'desc' },
    select: { contentHash: true },
  });

  if (latest?.contentHash === hash) {
    return { locationId, created: !existing, snapshotCreated: false };
  }

  await ctx.db.locationSnapshot.create({
    data: {
      organizationId: ctx.organizationId,
      locationId,
      rawPayload: resource as unknown as Prisma.InputJsonValue,
      contentHash: hash,
      source: 'GBP_API',
    },
  });

  return { locationId, created: !existing, snapshotCreated: true };
}

/** Re-fetches one location from Google and snapshots it if changed. */
export async function syncLocation(ctx: TenantContext, locationId: string): Promise<{
  snapshotCreated: boolean;
}> {
  requireCapability(ctx, 'location:sync');

  const location = await ctx.db.location.findFirst({
    where: { id: locationId },
    include: { gbpAccount: { select: { id: true, connectionId: true } } },
  });
  if (!location) throw new NotFoundError('Location not found.');

  const provider = getGbpProvider();
  const accessToken = await getAccessToken(ctx.organizationId, location.gbpAccount.connectionId);

  const resource = await provider.getLocation(
    { accessToken, logContext: { organizationId: ctx.organizationId, locationId } },
    location.googleLocationName,
  );

  const outcome = await upsertLocation(ctx, location.gbpAccount.id, resource);

  await recordAuditEvent({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'location.synced',
    subjectType: 'Location',
    subjectId: locationId,
    metadata: { snapshotCreated: outcome.snapshotCreated },
  });

  return { snapshotCreated: outcome.snapshotCreated };
}

export interface LocationListItem {
  id: string;
  title: string;
  googleLocationName: string;
  primaryCategoryName: string | null;
  address: string | null;
  healthScore: number | null;
  lastAuditAt: Date | null;
  lastSyncedAt: Date | null;
  syncStatus: SyncStatus;
  isSuspended: boolean;
  openFindingCount: number;
}

function formatAddress(address: unknown): string | null {
  if (!address || typeof address !== 'object') return null;
  const value = address as { addressLines?: string[]; locality?: string; administrativeArea?: string };
  const parts = [...(value.addressLines ?? []), value.locality, value.administrativeArea].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length ? parts.join(', ') : null;
}

export async function listLocations(ctx: TenantContext): Promise<LocationListItem[]> {
  requireCapability(ctx, 'location:view');

  const locations = await ctx.db.location.findMany({
    orderBy: { title: 'asc' },
    include: {
      _count: { select: { auditFindings: { where: { status: 'OPEN' } } } },
    },
  });

  return locations.map((location) => ({
    id: location.id,
    title: location.title,
    googleLocationName: location.googleLocationName,
    primaryCategoryName: location.primaryCategoryName,
    address: formatAddress(location.address),
    healthScore: location.healthScore,
    lastAuditAt: location.lastAuditAt,
    lastSyncedAt: location.lastSyncedAt,
    syncStatus: location.syncStatus,
    isSuspended: location.isSuspended,
    openFindingCount: location._count.auditFindings,
  }));
}

export async function getLocation(ctx: TenantContext, locationId: string) {
  requireCapability(ctx, 'location:view');

  const location = await ctx.db.location.findFirst({ where: { id: locationId } });
  if (!location) throw new NotFoundError('Location not found.');
  return location;
}

/** Most recent snapshot for a location. Audits run against this. */
export async function getLatestSnapshot(ctx: TenantContext, locationId: string) {
  const snapshot = await ctx.db.locationSnapshot.findFirst({
    where: { locationId },
    orderBy: { capturedAt: 'desc' },
  });
  if (!snapshot) {
    throw new NotFoundError('No snapshot exists for this location yet. Sync it first.');
  }
  return snapshot;
}
