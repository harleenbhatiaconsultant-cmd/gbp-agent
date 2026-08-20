/**
 * Google Business Profile connection lifecycle.
 *
 * This service is the ONLY place a refresh token is decrypted. Nothing else
 * reads `encryptedRefreshToken`, and no function here returns it. Callers that
 * need to talk to Google ask for a short-lived access token instead.
 */

import { ConnectionStatus } from '@/generated/prisma/enums';
import { prisma } from '@/server/db';
import { requireCapability } from '@/server/auth/rbac';
import type { TenantContext } from '@/server/auth/tenant-context';
import { NotFoundError, ConflictError } from '@/server/errors';
import { sealToken, openToken } from '@/server/crypto/tokens';
import { recordAuditEvent } from '@/server/services/audit-events';
import { childLogger } from '@/server/observability/logger';
import {
  refreshAccessToken,
  revokeToken,
  type GoogleTokenSet,
} from '@/server/integrations/google/oauth';
import { GbpAuthError } from '@/server/integrations/google/errors';

/** Safe projection — deliberately has no token field of any kind. */
export interface ConnectionSummary {
  id: string;
  googleAccountEmail: string;
  status: ConnectionStatus;
  scopes: string[];
  lastRefreshAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  gbpAccountCount: number;
  locationCount: number;
}

export async function listConnections(ctx: TenantContext): Promise<ConnectionSummary[]> {
  requireCapability(ctx, 'connection:view');

  const connections = await ctx.db.googleConnection.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      _count: { select: { gbpAccounts: true } },
      gbpAccounts: { select: { _count: { select: { locations: true } } } },
    },
  });

  return connections.map((connection) => ({
    id: connection.id,
    googleAccountEmail: connection.googleAccountEmail,
    status: connection.status,
    scopes: connection.scopes,
    lastRefreshAt: connection.lastRefreshAt,
    lastSyncedAt: connection.lastSyncedAt,
    lastError: connection.lastError,
    createdAt: connection.createdAt,
    gbpAccountCount: connection._count.gbpAccounts,
    locationCount: connection.gbpAccounts.reduce((sum, a) => sum + a._count.locations, 0),
  }));
}

export interface UpsertConnectionInput {
  organizationId: string;
  userId: string | null;
  googleAccountEmail: string;
  tokens: GoogleTokenSet;
}

/**
 * Stores a newly authorized connection.
 *
 * Reconnecting the same Google account updates the existing record rather than
 * creating a duplicate, so previously imported locations keep their history.
 */
export async function upsertConnection(input: UpsertConnectionInput): Promise<{ id: string }> {
  if (!input.tokens.refreshToken) {
    // Without a refresh token the connection dies in an hour and cannot be
    // renewed. Better to fail loudly now than to appear connected and break later.
    throw new ConflictError(
      'Google did not return a refresh token. Remove this app from your Google account permissions and connect again.',
    );
  }

  const sealed = sealToken(input.tokens.refreshToken);

  const existing = await prisma.googleConnection.findUnique({
    where: {
      organizationId_googleAccountEmail: {
        organizationId: input.organizationId,
        googleAccountEmail: input.googleAccountEmail,
      },
    },
  });

  const connection = await prisma.$transaction(async (tx) => {
    const record = existing
      ? await tx.googleConnection.update({
          where: { id: existing.id },
          data: {
            encryptedRefreshToken: sealed.ciphertext,
            encryptionKeyVersion: sealed.keyVersion,
            accessTokenExpiresAt: input.tokens.expiresAt,
            scopes: input.tokens.scopes,
            status: ConnectionStatus.ACTIVE,
            lastRefreshAt: new Date(),
            lastError: null,
          },
        })
      : await tx.googleConnection.create({
          data: {
            organizationId: input.organizationId,
            googleAccountEmail: input.googleAccountEmail,
            encryptedRefreshToken: sealed.ciphertext,
            encryptionKeyVersion: sealed.keyVersion,
            accessTokenExpiresAt: input.tokens.expiresAt,
            scopes: input.tokens.scopes,
            status: ConnectionStatus.ACTIVE,
            lastRefreshAt: new Date(),
          },
        });

    await recordAuditEvent(
      {
        organizationId: input.organizationId,
        actorUserId: input.userId,
        action: 'connection.created',
        subjectType: 'GoogleConnection',
        subjectId: record.id,
        metadata: {
          googleAccountEmail: input.googleAccountEmail,
          scopes: input.tokens.scopes,
          reconnected: Boolean(existing),
        },
      },
      tx,
    );

    return record;
  });

  return { id: connection.id };
}

/**
 * In-process access-token cache.
 *
 * Access tokens are never persisted (ARCHITECTURE.md §9) — they live here for
 * their remaining lifetime and are re-derived after a restart. The 60-second
 * safety margin avoids handing out a token that expires mid-request.
 */
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Returns a valid access token for a connection, refreshing if needed.
 *
 * On `invalid_grant` the connection is marked NEEDS_RECONSENT and an audit
 * event is written — the customer revoked access and must reconnect. That is a
 * permanent state, not a retryable failure.
 */
export async function getAccessToken(
  organizationId: string,
  connectionId: string,
): Promise<string> {
  const cached = accessTokenCache.get(connectionId);
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return cached.token;
  }

  const connection = await prisma.googleConnection.findFirst({
    where: { id: connectionId, organizationId },
  });
  if (!connection) throw new NotFoundError('Google connection not found.');

  if (connection.status === ConnectionStatus.REVOKED) {
    throw new GbpAuthError('This Google connection has been revoked. Reconnect the account.');
  }

  const log = childLogger({ organizationId, connectionId });

  try {
    const refreshToken = openToken(connection.encryptedRefreshToken);
    const tokens = await refreshAccessToken(refreshToken);

    const expiresAt = tokens.expiresAt?.getTime() ?? Date.now() + 55 * 60_000;
    accessTokenCache.set(connectionId, { token: tokens.accessToken, expiresAt });

    await prisma.googleConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenExpiresAt: tokens.expiresAt,
        lastRefreshAt: new Date(),
        status: ConnectionStatus.ACTIVE,
        lastError: null,
        // Google occasionally issues a replacement refresh token.
        ...(tokens.refreshToken
          ? (() => {
              const sealed = sealToken(tokens.refreshToken);
              return {
                encryptedRefreshToken: sealed.ciphertext,
                encryptionKeyVersion: sealed.keyVersion,
              };
            })()
          : {}),
      },
    });

    return tokens.accessToken;
  } catch (error) {
    const permanent = error instanceof GbpAuthError;
    const message = error instanceof Error ? error.message : 'Token refresh failed';

    await prisma.googleConnection.update({
      where: { id: connection.id },
      data: {
        status: permanent ? ConnectionStatus.NEEDS_RECONSENT : ConnectionStatus.ERROR,
        lastError: message.slice(0, 500),
      },
    });

    await recordAuditEvent({
      organizationId,
      action: 'connection.failed',
      subjectType: 'GoogleConnection',
      subjectId: connection.id,
      metadata: { permanent, reason: message.slice(0, 200) },
    }).catch(() => undefined);

    log.error({ err: error, permanent }, 'Failed to obtain a Google access token');
    throw error;
  }
}

/**
 * Tombstone written over a revoked credential.
 *
 * Deliberately not valid ciphertext: any attempt to use it fails loudly at
 * `openToken` rather than silently producing a token-shaped string.
 */
const REVOKED_TOKEN_TOMBSTONE = 'revoked.revoked.revoked.revoked';

/**
 * Disconnects a Google account.
 *
 * Revokes the token at Google, then destroys the local credential by
 * overwriting it. The connection ROW IS RETAINED with status REVOKED, and the
 * imported locations and their history are retained with it.
 *
 * This is not squeamishness about deletion. Deleting the connection would
 * cascade through GbpAccount and Location into ChangeLog, and ChangeLog is
 * append-only — so the delete is refused by the database the moment a customer
 * has ever had a change applied. More importantly it SHOULD be refused: the
 * record of what was changed on someone's business listing must not evaporate
 * because they unplugged an integration.
 *
 * Purging a tenant's data is a separate, deliberate retention operation that
 * archives the compliance trail first. It is not a side effect of disconnecting.
 */
export async function disconnect(ctx: TenantContext, connectionId: string): Promise<void> {
  requireCapability(ctx, 'connection:manage');

  const connection = await ctx.db.googleConnection.findFirst({ where: { id: connectionId } });
  if (!connection) throw new NotFoundError('Google connection not found.');

  let revoked = false;
  try {
    const refreshToken = openToken(connection.encryptedRefreshToken);
    ({ revoked } = await revokeToken(refreshToken));
  } catch (error) {
    childLogger({ organizationId: ctx.organizationId, connectionId }).warn(
      { err: error },
      'Could not revoke token at Google; deleting the local credential regardless',
    );
  }

  accessTokenCache.delete(connectionId);

  await prisma.$transaction(async (tx) => {
    // Destroy the credential in place. Retaining the row keeps the imported
    // locations and their change history intact and referentially valid.
    await tx.googleConnection.update({
      where: { id: connectionId },
      data: {
        encryptedRefreshToken: REVOKED_TOKEN_TOMBSTONE,
        encryptionKeyVersion: 0,
        accessTokenExpiresAt: null,
        status: ConnectionStatus.REVOKED,
        lastError: null,
      },
    });

    await recordAuditEvent(
      {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'connection.revoked',
        subjectType: 'GoogleConnection',
        subjectId: connectionId,
        metadata: { googleAccountEmail: connection.googleAccountEmail, revokedAtGoogle: revoked },
      },
      tx,
    );
  });
}

/** Clears the in-process token cache. Used by tests and on shutdown. */
export function clearAccessTokenCache(): void {
  accessTokenCache.clear();
}
