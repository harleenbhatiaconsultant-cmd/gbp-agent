/**
 * Data-layer entry point.
 *
 * Import from `@/server/db` rather than reaching into the individual modules.
 * Route handlers and React components must not import this at all — all
 * database access goes through `@/server/services/*` (enforced by the
 * no-restricted-imports zones in eslint.config.mjs).
 */

export { prisma, APPEND_ONLY_MODELS } from '@/server/db/client';
export type { ExtendedPrismaClient } from '@/server/db/client';
export { tenantDb, NON_TENANT_MODELS } from '@/server/db/tenant';
export type { TenantPrismaClient } from '@/server/db/tenant';
