/**
 * Session resolution — the single entry point that turns an HTTP request into
 * a TenantContext.
 *
 * Nothing below this file reads cookies, headers or the session. Services take
 * a TenantContext and trust it, which is only safe because this module is the
 * one place that constructs one.
 */

import { cache } from 'react';
import { auth } from '@/server/auth';
import { prisma } from '@/server/db';
import { tenantDb } from '@/server/db/tenant';
import { NotFoundError, UnauthenticatedError } from '@/server/errors';
import type { TenantContext } from '@/server/auth/tenant-context';

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

/**
 * The signed-in user, or null.
 *
 * Re-reads the user row rather than trusting the token: with JWT sessions a
 * token outlives a deleted account, so existence is verified here. `cache`
 * dedupes this to one query per request across all server components.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, image: true },
  });

  // Token valid but the account is gone — treat as signed out.
  return user ?? null;
});

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthenticatedError();
  return user;
}

/**
 * Builds the TenantContext for an organization slug.
 *
 * Membership is re-read on every request, so removing someone from an
 * organization takes effect on their next page load regardless of token
 * lifetime. A non-member gets NotFound rather than Forbidden — confirming that
 * an organization exists is itself a leak.
 */
export const resolveTenantContext = cache(
  async (organizationSlug: string): Promise<TenantContext> => {
    const user = await requireUser();

    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, organization: { slug: organizationSlug } },
      include: { organization: true },
    });

    if (!membership) {
      throw new NotFoundError('Organization not found.', { slug: organizationSlug });
    }

    return {
      organizationId: membership.organizationId,
      organizationSlug: membership.organization.slug,
      plan: membership.organization.plan,
      userId: user.id,
      role: membership.role,
      isElevated: false,
      db: tenantDb(membership.organizationId),
    };
  },
);

/**
 * Where to send a signed-in user who has not named an organization.
 * Returns null when they belong to none, so the caller can route to onboarding.
 */
export async function getDefaultOrganizationSlug(userId: string): Promise<string | null> {
  const membership = await prisma.membership.findFirst({
    where: { userId },
    include: { organization: { select: { slug: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return membership?.organization.slug ?? null;
}
