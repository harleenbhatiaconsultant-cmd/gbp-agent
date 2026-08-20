/**
 * Validation schemas for organization and membership operations.
 *
 * Shared between client forms and server services so a rule is written once.
 * Server-side validation is never skipped just because the form validated.
 */

import { z } from 'zod';
import { MemberRole, OrganizationType } from '@/generated/prisma/enums';

export const organizationSlugSchema = z
  .string()
  .min(3, 'Slug must be at least 3 characters')
  .max(40, 'Slug must be at most 40 characters')
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Slug may contain lowercase letters, numbers and single hyphens only',
  )
  .refine((slug) => !RESERVED_SLUGS.has(slug), 'That slug is reserved');

/** Route segments that would collide with application paths. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'auth',
  'admin',
  'app',
  'dashboard',
  'settings',
  'sign-in',
  'sign-out',
  'new',
  'select',
  'health',
  'static',
  '_next',
]);

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
  slug: organizationSlugSchema.optional(),
  type: z.enum(OrganizationType).default(OrganizationType.BUSINESS),
});
// `z.input`, not `z.infer`: this is what a CALLER passes, so fields carrying a
// default (`type`) must stay optional. `z.infer` would describe the parsed
// result, where the default has already been applied and the field is required.
export type CreateOrganizationInput = z.input<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const inviteMemberSchema = z.object({
  email: z.email('Enter a valid email address').toLowerCase(),
  // OWNER is deliberately absent: ownership transfer is a separate, explicit
  // operation, not something an invitation can grant.
  role: z.enum([MemberRole.ADMIN, MemberRole.EDITOR, MemberRole.VIEWER]),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const changeMemberRoleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum([MemberRole.ADMIN, MemberRole.EDITOR, MemberRole.VIEWER]),
});
export type ChangeMemberRoleInput = z.infer<typeof changeMemberRoleSchema>;
