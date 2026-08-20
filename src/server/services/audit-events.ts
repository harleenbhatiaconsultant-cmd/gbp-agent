/**
 * Security and authorization audit trail.
 *
 * Distinct from ChangeLog: this records who signed in, who was granted access,
 * who connected or disconnected a Google account. ChangeLog records mutations
 * to customer business profiles.
 *
 * AuditEvent is append-only (Prisma extension + Postgres trigger), so a write
 * here is permanent by construction.
 */

import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { logger } from '@/server/observability/logger';

/**
 * Actions worth reconstructing later. Kept as a union rather than free text so
 * the trail stays queryable and a typo cannot create a silent second category.
 */
export type AuditAction =
  | 'auth.signed_in'
  | 'auth.signed_out'
  | 'organization.created'
  | 'organization.updated'
  | 'member.invited'
  | 'member.joined'
  | 'member.role_changed'
  | 'member.removed'
  | 'connection.created'
  | 'connection.refreshed'
  | 'connection.revoked'
  | 'connection.failed'
  | 'location.imported'
  | 'location.synced'
  | 'audit.run'
  | 'change.requested'
  | 'change.approved'
  | 'change.rejected'
  | 'change.executed';

export interface AuditEventInput {
  organizationId: string;
  action: AuditAction;
  subjectType: string;
  subjectId?: string | null;
  actorUserId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Writes an audit event.
 *
 * Accepts an optional transaction client so the event can be committed atomically
 * with the thing it describes — an audit trail that can disagree with the data it
 * describes is worse than none.
 */
export async function recordAuditEvent(
  input: AuditEventInput,
  tx?: Pick<typeof prisma, 'auditEvent'>,
): Promise<void> {
  const client = tx ?? prisma;

  await client.auditEvent.create({
    data: {
      organizationId: input.organizationId,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      actorUserId: input.actorUserId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata: input.metadata,
    },
  });
}

/**
 * Best-effort variant for paths where losing the event is preferable to failing
 * the operation — sign-in, for example, should not break because the audit
 * insert hit a transient error. Use `recordAuditEvent` everywhere else.
 */
export async function recordAuditEventSafe(input: AuditEventInput): Promise<void> {
  try {
    await recordAuditEvent(input);
  } catch (error) {
    logger.error(
      { err: error, action: input.action, organizationId: input.organizationId },
      'Failed to record audit event',
    );
  }
}
