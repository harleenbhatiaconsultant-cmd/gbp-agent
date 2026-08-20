/**
 * Role-based access control.
 *
 * Capabilities are checked HERE, in the service layer — never only in the UI.
 * Hiding a button is a usability affordance; this module is the security
 * boundary. Every mutating service call must assert a capability.
 */

import { MemberRole } from '@/generated/prisma/enums';
import { ForbiddenError, UnauthenticatedError } from '@/server/errors';
import { isUserContext, type TenantContext } from '@/server/auth/tenant-context';

export type Capability =
  | 'organization:view'
  | 'organization:update'
  | 'members:view'
  | 'members:manage'
  | 'billing:manage'
  | 'connection:view'
  | 'connection:manage'
  | 'location:view'
  | 'location:sync'
  | 'audit:run'
  | 'change:draft'
  /** Approving a change is what authorizes a real mutation of a customer profile. */
  | 'change:approve'
  | 'change:execute'
  | 'post:draft'
  | 'post:publish'
  | 'review:respond'
  | 'report:generate'
  | 'apikey:manage';

const ROLE_CAPABILITIES: Readonly<Record<MemberRole, readonly Capability[]>> = {
  [MemberRole.OWNER]: [
    'organization:view',
    'organization:update',
    'members:view',
    'members:manage',
    'billing:manage',
    'connection:view',
    'connection:manage',
    'location:view',
    'location:sync',
    'audit:run',
    'change:draft',
    'change:approve',
    'change:execute',
    'post:draft',
    'post:publish',
    'review:respond',
    'report:generate',
    'apikey:manage',
  ],
  [MemberRole.ADMIN]: [
    'organization:view',
    'organization:update',
    'members:view',
    'members:manage',
    'connection:view',
    'connection:manage',
    'location:view',
    'location:sync',
    'audit:run',
    'change:draft',
    'change:approve',
    'change:execute',
    'post:draft',
    'post:publish',
    'review:respond',
    'report:generate',
    'apikey:manage',
  ],
  // EDITOR may prepare work but may never authorize a profile mutation.
  [MemberRole.EDITOR]: [
    'organization:view',
    'members:view',
    'connection:view',
    'location:view',
    'location:sync',
    'audit:run',
    'change:draft',
    'post:draft',
    'review:respond',
    'report:generate',
  ],
  [MemberRole.VIEWER]: [
    'organization:view',
    'members:view',
    'connection:view',
    'location:view',
  ],
};

/**
 * What a background job may do on its own authority.
 *
 * Scheduled work may OBSERVE and DIAGNOSE — sync from Google, run an audit,
 * generate a report. It may not authorize anything: approving a change,
 * managing a connection, changing membership or billing all require a person,
 * and are absent here deliberately.
 *
 * `change:execute` is also absent. A job can still carry out an approved
 * change, but only by presenting the stored approval — see `authorizeExecution`
 * in the changes service. That way enqueueing a job can never become a route to
 * applying something nobody approved.
 */
const SYSTEM_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'organization:view',
  'members:view',
  'connection:view',
  'location:view',
  'location:sync',
  'audit:run',
  'report:generate',
]);

export function roleHasCapability(role: MemberRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export function systemHasCapability(capability: Capability): boolean {
  return SYSTEM_CAPABILITIES.has(capability);
}

export function can(ctx: TenantContext, capability: Capability): boolean {
  if (!isUserContext(ctx)) return systemHasCapability(capability);
  return roleHasCapability(ctx.role, capability);
}

/**
 * Asserts the acting context holds a capability. Throws otherwise.
 * Call at the top of every mutating service function.
 */
export function requireCapability(ctx: TenantContext, capability: Capability): void {
  if (!isUserContext(ctx)) {
    if (systemHasCapability(capability)) return;
    throw new UnauthenticatedError(
      `Capability "${capability}" requires a signed-in user; this context is system-initiated ` +
        'and background work may observe and diagnose, but never authorize.',
    );
  }
  if (!roleHasCapability(ctx.role, capability)) {
    throw new ForbiddenError(
      `Your role (${ctx.role}) cannot perform this action.`,
      { capability, role: ctx.role },
    );
  }
}

/**
 * Asserts that a NAMED HUMAN is approving a change.
 *
 * Deliberately separate from `requireCapability('change:approve')`: approval is
 * the moment a real customer profile mutation becomes authorized, and it must
 * always be attributable to a person. System contexts can never satisfy it.
 */
export function requireHumanApprover(ctx: TenantContext): { userId: string; role: MemberRole } {
  if (!isUserContext(ctx)) {
    throw new ForbiddenError(
      'Change approval requires a signed-in human approver. System contexts cannot approve changes.',
    );
  }
  if (!roleHasCapability(ctx.role, 'change:approve')) {
    throw new ForbiddenError(
      `Your role (${ctx.role}) cannot approve changes. Only OWNER and ADMIN may approve.`,
      { role: ctx.role },
    );
  }
  return { userId: ctx.userId, role: ctx.role };
}

export { MemberRole };
