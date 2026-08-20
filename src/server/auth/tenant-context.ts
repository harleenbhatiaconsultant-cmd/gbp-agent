/**
 * TenantContext — the resolved answer to "who is acting, on behalf of which
 * organization, with what authority".
 *
 * Resolved ONCE at the entry point (route handler, server action, or job) and
 * then threaded explicitly as the first argument to every service call. Nothing
 * below the entry point reads the session, cookies, or request headers.
 *
 * Phase 1 adds `resolveTenantContext()` for HTTP requests. This module defines
 * the shape and the job-side constructor so the type is settled before services
 * start depending on it.
 */

import type { MemberRole, PlanTier } from '@/generated/prisma/enums';
import type { TenantPrismaClient } from '@/server/db/tenant';
import { tenantDb } from '@/server/db/tenant';

export interface TenantContext {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly plan: PlanTier;
  /** Absent for system-initiated work (scheduled jobs, webhooks). */
  readonly userId: string | null;
  /**
   * The acting user's role in this organization. System work runs as `null`
   * and must pass an explicit capability check rather than assuming authority.
   */
  readonly role: MemberRole | null;
  /** True when an agency user is acting inside a child organization. */
  readonly isElevated: boolean;
  /** Tenant-confined database client for this organization. */
  readonly db: TenantPrismaClient;
}

/**
 * Builds a context for system-initiated work — scheduled syncs, webhook
 * handlers, queue workers. There is no acting user, so `role` is null and
 * capability checks must be explicit at the call site.
 */
export function createSystemContext(params: {
  organizationId: string;
  organizationSlug: string;
  plan: PlanTier;
}): TenantContext {
  return {
    organizationId: params.organizationId,
    organizationSlug: params.organizationSlug,
    plan: params.plan,
    userId: null,
    role: null,
    isElevated: false,
    db: tenantDb(params.organizationId),
  };
}

/** True when the context represents a real signed-in human. */
export function isUserContext(
  ctx: TenantContext,
): ctx is TenantContext & { userId: string; role: MemberRole } {
  return ctx.userId !== null && ctx.role !== null;
}
