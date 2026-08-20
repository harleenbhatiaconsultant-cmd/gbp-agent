/**
 * Organization and membership management.
 *
 * `Organization` is the tenant root and is exempt from automatic tenant scoping
 * (it has no `organizationId` of its own), so every function here scopes by
 * `id` explicitly and checks membership before returning anything.
 */

import { MemberRole, OrganizationType, PlanTier } from '@/generated/prisma/enums';
import { prisma } from '@/server/db';
import { NotFoundError, ConflictError, ForbiddenError, BadRequestError } from '@/server/errors';
import { requireCapability } from '@/server/auth/rbac';
import type { TenantContext } from '@/server/auth/tenant-context';
import { recordAuditEvent } from '@/server/services/audit-events';
import { uniqueSlug } from '@/lib/slug';
import {
  createOrganizationSchema,
  inviteMemberSchema,
  changeMemberRoleSchema,
  organizationSlugSchema,
  type CreateOrganizationInput,
  type InviteMemberInput,
  type ChangeMemberRoleInput,
} from '@/schemas/organization';
import { randomBytes, createHash } from 'node:crypto';

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  type: OrganizationType;
  plan: PlanTier;
  role: MemberRole;
}

/** Every organization the user belongs to. Powers the org switcher. */
export async function listOrganizationsForUser(userId: string): Promise<OrganizationSummary[]> {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: { organization: true },
    orderBy: { createdAt: 'asc' },
  });

  return memberships.map((m) => ({
    id: m.organization.id,
    name: m.organization.name,
    slug: m.organization.slug,
    type: m.organization.type,
    plan: m.organization.plan,
    role: m.role,
  }));
}

/**
 * Creates an organization and makes the creator its OWNER.
 *
 * The organization, the owning membership and the audit event are written in a
 * single transaction: an organization with no owner would be unreachable, and
 * an unaudited creation would leave a gap in the trail.
 */
export async function createOrganization(
  userId: string,
  input: CreateOrganizationInput,
): Promise<OrganizationSummary> {
  const parsed = createOrganizationSchema.parse(input);

  const slug = parsed.slug
    ? parsed.slug
    : await uniqueSlug(parsed.name, async (candidate) => {
        const existing = await prisma.organization.findUnique({ where: { slug: candidate } });
        return existing !== null;
      });

  // An explicitly supplied slug still has to be free.
  organizationSlugSchema.parse(slug);

  const existing = await prisma.organization.findUnique({ where: { slug } });
  if (existing) {
    throw new ConflictError(`The slug "${slug}" is already taken.`, { slug });
  }

  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: { name: parsed.name, slug, type: parsed.type },
    });

    await tx.membership.create({
      data: { organizationId: organization.id, userId, role: MemberRole.OWNER },
    });

    await recordAuditEvent(
      {
        organizationId: organization.id,
        actorUserId: userId,
        action: 'organization.created',
        subjectType: 'Organization',
        subjectId: organization.id,
        metadata: { slug, type: parsed.type },
      },
      tx,
    );

    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      type: organization.type,
      plan: organization.plan,
      role: MemberRole.OWNER,
    };
  });
}

/**
 * Resolves a slug to an organization the user actually belongs to.
 *
 * Returns not-found for an organization that exists but the user cannot access —
 * distinguishing "no such org" from "not yours" would confirm its existence.
 */
export async function getOrganizationForUser(
  userId: string,
  slug: string,
): Promise<OrganizationSummary> {
  const membership = await prisma.membership.findFirst({
    where: { userId, organization: { slug } },
    include: { organization: true },
  });

  if (!membership) {
    throw new NotFoundError('Organization not found.', { slug });
  }

  return {
    id: membership.organization.id,
    name: membership.organization.name,
    slug: membership.organization.slug,
    type: membership.organization.type,
    plan: membership.organization.plan,
    role: membership.role,
  };
}

export interface MemberSummary {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  role: MemberRole;
  joinedAt: Date;
}

export async function listMembers(ctx: TenantContext): Promise<MemberSummary[]> {
  requireCapability(ctx, 'members:view');

  const memberships = await prisma.membership.findMany({
    where: { organizationId: ctx.organizationId },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  });

  return memberships.map((m) => ({
    userId: m.userId,
    email: m.user.email,
    name: m.user.name,
    image: m.user.image,
    role: m.role,
    joinedAt: m.createdAt,
  }));
}

export interface InvitationResult {
  id: string;
  email: string;
  role: MemberRole;
  expiresAt: Date;
  /** Shown once, never stored in plaintext. Delivered by email in a later phase. */
  token: string;
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function inviteMember(
  ctx: TenantContext,
  input: InviteMemberInput,
): Promise<InvitationResult> {
  requireCapability(ctx, 'members:manage');
  const parsed = inviteMemberSchema.parse(input);

  const alreadyMember = await prisma.membership.findFirst({
    where: { organizationId: ctx.organizationId, user: { email: parsed.email } },
  });
  if (alreadyMember) {
    throw new ConflictError('That person is already a member of this organization.');
  }

  // Only the token hash is stored; the plaintext is returned once to the caller.
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  const invitation = await prisma.$transaction(async (tx) => {
    const created = await tx.invitation.create({
      data: {
        organizationId: ctx.organizationId,
        email: parsed.email,
        role: parsed.role,
        tokenHash: hashToken(token),
        expiresAt,
        invitedByUserId: ctx.userId,
      },
    });

    await recordAuditEvent(
      {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'member.invited',
        subjectType: 'Invitation',
        subjectId: created.id,
        metadata: { email: parsed.email, role: parsed.role },
      },
      tx,
    );

    return created;
  });

  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
    token,
  };
}

/** Redeems an invitation for the signed-in user. */
export async function acceptInvitation(userId: string, token: string): Promise<OrganizationSummary> {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { organization: true },
  });

  if (!invitation || invitation.acceptedAt || invitation.expiresAt < new Date()) {
    // One message for all three cases: a valid-but-expired token and a forged
    // one should be indistinguishable to the caller.
    throw new NotFoundError('That invitation is not valid.');
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User not found.');

  if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
    throw new ForbiddenError('This invitation was issued to a different email address.');
  }

  return prisma.$transaction(async (tx) => {
    await tx.membership.create({
      data: {
        organizationId: invitation.organizationId,
        userId,
        role: invitation.role,
      },
    });

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });

    await recordAuditEvent(
      {
        organizationId: invitation.organizationId,
        actorUserId: userId,
        action: 'member.joined',
        subjectType: 'Membership',
        subjectId: userId,
        metadata: { role: invitation.role },
      },
      tx,
    );

    return {
      id: invitation.organization.id,
      name: invitation.organization.name,
      slug: invitation.organization.slug,
      type: invitation.organization.type,
      plan: invitation.organization.plan,
      role: invitation.role,
    };
  });
}

export async function changeMemberRole(
  ctx: TenantContext,
  input: ChangeMemberRoleInput,
): Promise<void> {
  requireCapability(ctx, 'members:manage');
  const parsed = changeMemberRoleSchema.parse(input);

  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: parsed.userId, organizationId: ctx.organizationId } },
  });
  if (!membership) throw new NotFoundError('That person is not a member of this organization.');

  // Demoting the last owner would leave the organization unadministrable.
  if (membership.role === MemberRole.OWNER) {
    await assertNotLastOwner(ctx.organizationId, parsed.userId);
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.update({
      where: { userId_organizationId: { userId: parsed.userId, organizationId: ctx.organizationId } },
      data: { role: parsed.role },
    });

    await recordAuditEvent(
      {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'member.role_changed',
        subjectType: 'Membership',
        subjectId: parsed.userId,
        metadata: { from: membership.role, to: parsed.role },
      },
      tx,
    );
  });
}

export async function removeMember(ctx: TenantContext, userId: string): Promise<void> {
  requireCapability(ctx, 'members:manage');

  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId: ctx.organizationId } },
  });
  if (!membership) throw new NotFoundError('That person is not a member of this organization.');

  if (membership.role === MemberRole.OWNER) {
    await assertNotLastOwner(ctx.organizationId, userId);
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.delete({
      where: { userId_organizationId: { userId, organizationId: ctx.organizationId } },
    });

    await recordAuditEvent(
      {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'member.removed',
        subjectType: 'Membership',
        subjectId: userId,
        metadata: { role: membership.role },
      },
      tx,
    );
  });
}

async function assertNotLastOwner(organizationId: string, userId: string): Promise<void> {
  const ownerCount = await prisma.membership.count({
    where: { organizationId, role: MemberRole.OWNER },
  });
  if (ownerCount <= 1) {
    throw new BadRequestError(
      'This is the only owner of the organization. Promote another member to owner first.',
      { userId },
    );
  }
}
