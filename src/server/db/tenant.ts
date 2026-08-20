/**
 * Tenant-scoped database access.
 *
 * `tenantDb(organizationId)` returns a Prisma client that automatically confines
 * every tenant-owned query to one organization. A forgotten `where` clause
 * becomes a scoped query rather than a cross-tenant leak.
 *
 * This is defense in depth, NOT a licence to stop thinking: services should
 * still express their intent explicitly. The extension is the backstop that
 * turns a mistake into a non-event.
 *
 * Enforcement by operation shape:
 *   - Operations accepting a free-form `where` (findFirst, findMany, count,
 *     aggregate, groupBy, updateMany, deleteMany) get `organizationId` merged in.
 *   - Single-record `update` and `delete` also get `organizationId` merged into
 *     `where`. Prisma permits non-unique fields alongside a unique selector, so
 *     a row owned by another tenant simply does not match and the operation
 *     raises a not-found error. This is transaction-safe: no side query is
 *     issued, so uncommitted rows inside an interactive transaction behave
 *     correctly.
 *   - `findUnique` / `findUniqueOrThrow` cannot take a non-unique filter, so the
 *     result is checked after the fact and treated as absent if it belongs to
 *     another tenant.
 *   - `create` / `createMany` verify `organizationId` when the payload declares
 *     it, and stamp it when it does not. Prisma's generated types require the
 *     field, so services normally pass `ctx.organizationId` explicitly and this
 *     layer acts as the check; the stamping path is the safety net for callers
 *     that omit it.
 *   - `upsert` is REFUSED on tenant models — see the note on it below.
 */

import { prisma, type ExtendedPrismaClient } from '@/server/db/client';
import { TenantIsolationError } from '@/server/errors';

/**
 * Models that are NOT tenant-scoped, with the reason each is exempt.
 * This list mirrors the comments in prisma/schema.prisma and must stay in sync
 * with it — a new model is tenant-scoped unless it is added here deliberately.
 */
export const NON_TENANT_MODELS: Readonly<Record<string, string>> = {
  // Global identity — a user exists independently of any organization.
  User: 'global identity',
  Account: 'global identity (Auth.js)',
  Session: 'global identity (Auth.js)',
  VerificationToken: 'global identity (Auth.js)',

  // The tenant root itself. Scope by `id`, not by `organizationId`.
  Organization: 'tenant root',

  // Platform-wide configuration, identical for every tenant.
  PlanLimit: 'global plan configuration',

  // Child-only rows, always reached through a tenant-scoped parent.
  RankPoint: 'child of RankScan',
  SitePage: 'child of SiteCrawl',
  CompetitorSnapshot: 'child of Competitor',

  // organizationId is nullable (system-level jobs have none), so automatic
  // injection would hide system rows. Callers filter explicitly.
  JobRun: 'nullable organizationId',
};

export function isTenantScopedModel(model: string | undefined): model is string {
  return typeof model === 'string' && !(model in NON_TENANT_MODELS);
}

/** Operations whose `where` accepts arbitrary (non-unique) filters. */
const WHERE_FILTERABLE_OPERATIONS: ReadonlySet<string> = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'updateManyAndReturn',
  'deleteMany',
  // Prisma allows non-unique filters alongside a unique selector on these.
  'update',
  'delete',
]);

const CREATE_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
]);

const FIND_UNIQUE_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
]);

type AnyArgs = Record<string, unknown>;

function mergeWhere(args: AnyArgs, organizationId: string): AnyArgs {
  const existing = (args.where ?? {}) as Record<string, unknown>;
  return { ...args, where: { ...existing, organizationId } };
}

function stampCreateData(
  data: unknown,
  organizationId: string,
  model: string,
): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => stampCreateData(row, organizationId, model));
  }
  if (data && typeof data === 'object') {
    const row = data as Record<string, unknown>;
    const declared = row.organizationId;
    if (typeof declared === 'string' && declared !== organizationId) {
      // Writing into another tenant is never a legitimate accident.
      throw new TenantIsolationError(model, {
        reason: 'create payload declared a different organizationId',
      });
    }
    return { ...row, organizationId };
  }
  return data;
}

/**
 * Returns a Prisma client confined to a single organization.
 *
 * Construct one per request or job from the resolved TenantContext and pass it
 * down; do not cache it across tenants.
 */
export function tenantDb(organizationId: string) {
  if (!organizationId) {
    throw new TenantIsolationError('unknown', {
      reason: 'tenantDb called without an organizationId',
    });
  }

  return prisma.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!isTenantScopedModel(model)) {
            return query(args);
          }

          const typedArgs = (args ?? {}) as AnyArgs;

          // ---- reads and mutations that accept a filter -------------------
          if (WHERE_FILTERABLE_OPERATIONS.has(operation)) {
            return query(mergeWhere(typedArgs, organizationId));
          }

          // ---- creates: verify ownership, and stamp it if absent ----------
          if (CREATE_OPERATIONS.has(operation)) {
            return query({
              ...typedArgs,
              data: stampCreateData(typedArgs.data, organizationId, model),
            } as typeof args);
          }

          // ---- findUnique: verify ownership of the result -----------------
          if (FIND_UNIQUE_OPERATIONS.has(operation)) {
            const result = (await query(typedArgs)) as Record<string, unknown> | null;
            if (
              result &&
              typeof result.organizationId === 'string' &&
              result.organizationId !== organizationId
            ) {
              if (operation === 'findUniqueOrThrow') {
                throw new TenantIsolationError(model, { operation });
              }
              // Treat as absent rather than forbidden — confirming that a row
              // exists in another tenant is itself an information leak.
              return null;
            }
            return result;
          }

          // ---- upsert: refused -------------------------------------------
          // `upsert` requires a strictly unique `where`, so organizationId
          // cannot be merged into it. Given a unique selector belonging to
          // another tenant it would silently UPDATE that tenant's row. There is
          // no safe automatic scoping, so it fails closed.
          if (operation === 'upsert') {
            throw new TenantIsolationError(model, {
              reason:
                'upsert cannot be tenant-scoped safely. Use findFirst + create/update inside a transaction instead.',
            });
          }

          // Unknown operation shape: fail closed rather than pass it through
          // unscoped. Add it to one of the sets above deliberately.
          throw new TenantIsolationError(model, {
            reason: `operation "${operation}" has no tenant-scoping rule`,
          });
        },
      },
    },
  });
}

export type TenantPrismaClient = ReturnType<typeof tenantDb>;
export type { ExtendedPrismaClient };
