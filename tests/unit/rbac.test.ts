import { describe, it, expect } from 'vitest';
import { MemberRole } from '@/generated/prisma/enums';
import { roleHasCapability, requireCapability, requireHumanApprover, can } from '@/server/auth/rbac';
import { createSystemContext } from '@/server/auth/tenant-context';
import type { TenantContext } from '@/server/auth/tenant-context';
import { PlanTier } from '@/generated/prisma/enums';

function userContext(role: MemberRole): TenantContext {
  return {
    ...createSystemContext({
      organizationId: 'org_rbac_test',
      organizationSlug: 'rbac-test',
      plan: PlanTier.FREE,
    }),
    userId: 'user_1',
    role,
  };
}

describe('role capabilities', () => {
  it('lets OWNER and ADMIN approve changes', () => {
    expect(roleHasCapability(MemberRole.OWNER, 'change:approve')).toBe(true);
    expect(roleHasCapability(MemberRole.ADMIN, 'change:approve')).toBe(true);
  });

  it('does not let EDITOR approve changes, only draft them', () => {
    expect(roleHasCapability(MemberRole.EDITOR, 'change:draft')).toBe(true);
    expect(roleHasCapability(MemberRole.EDITOR, 'change:approve')).toBe(false);
  });

  it('gives VIEWER no mutating capability', () => {
    expect(roleHasCapability(MemberRole.VIEWER, 'change:draft')).toBe(false);
    expect(roleHasCapability(MemberRole.VIEWER, 'connection:manage')).toBe(false);
    expect(roleHasCapability(MemberRole.VIEWER, 'location:view')).toBe(true);
  });

  it('restricts billing to OWNER', () => {
    expect(roleHasCapability(MemberRole.OWNER, 'billing:manage')).toBe(true);
    expect(roleHasCapability(MemberRole.ADMIN, 'billing:manage')).toBe(false);
  });
});

describe('requireCapability', () => {
  it('passes for a permitted role', () => {
    expect(() => requireCapability(userContext(MemberRole.ADMIN), 'change:approve')).not.toThrow();
  });

  it('throws for an unpermitted role', () => {
    expect(() => requireCapability(userContext(MemberRole.EDITOR), 'change:approve')).toThrowError(
      /cannot perform this action/,
    );
  });

  it('throws for a system context, which has no role', () => {
    const system = createSystemContext({
      organizationId: 'org_rbac_test',
      organizationSlug: 'rbac-test',
      plan: PlanTier.FREE,
    });
    expect(() => requireCapability(system, 'change:draft')).toThrowError(/system-initiated/);
    expect(can(system, 'change:draft')).toBe(false);
  });
});

describe('requireHumanApprover', () => {
  it('returns the approving user for OWNER', () => {
    expect(requireHumanApprover(userContext(MemberRole.OWNER))).toEqual({
      userId: 'user_1',
      role: MemberRole.OWNER,
    });
  });

  it('refuses a system context — approval must be attributable to a person', () => {
    const system = createSystemContext({
      organizationId: 'org_rbac_test',
      organizationSlug: 'rbac-test',
      plan: PlanTier.FREE,
    });
    expect(() => requireHumanApprover(system)).toThrowError(/human approver/);
  });

  it('refuses EDITOR', () => {
    expect(() => requireHumanApprover(userContext(MemberRole.EDITOR))).toThrowError(
      /cannot approve changes/,
    );
  });
});
