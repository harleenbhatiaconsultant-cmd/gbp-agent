/**
 * TenantContext for system-initiated work.
 *
 * Background jobs have no signed-in user. They get a context with `userId` and
 * `role` null, which means every capability check fails for them — deliberately.
 * A scheduled job carries no authority of its own; it can only carry out work a
 * human already authorized, and services that accept system contexts say so
 * explicitly (see `executeChange`).
 */

import { prisma } from '@/server/db';
import { NotFoundError } from '@/server/errors';
import { createSystemContext, type TenantContext } from '@/server/auth/tenant-context';

export async function loadSystemContext(organizationId: string): Promise<TenantContext> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, slug: true, plan: true, status: true },
  });

  if (!organization) {
    throw new NotFoundError('Organization not found.', { organizationId });
  }

  if (organization.status !== 'ACTIVE') {
    // A suspended or cancelled tenant should not have background work running
    // against their Google account.
    throw new NotFoundError('Organization is not active.', {
      organizationId,
      status: organization.status,
    });
  }

  return createSystemContext({
    organizationId: organization.id,
    organizationSlug: organization.slug,
    plan: organization.plan,
  });
}
