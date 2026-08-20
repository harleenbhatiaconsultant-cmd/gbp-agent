/**
 * Prisma client construction.
 *
 * Prisma 7 requires an explicit driver adapter for SQL providers, and generates
 * the client into src/generated/prisma rather than node_modules. Import the
 * client from here — never construct a second PrismaClient.
 *
 * The exported `prisma` is the BASE client. It already carries the append-only
 * guard, but it is NOT tenant-scoped: it can read across organizations. Use it
 * only for global models (User, Session, PlanLimit) and system-level work.
 * For anything tenant-owned, use `tenantDb(organizationId)` from ./tenant.
 */

import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env, isProduction } from '@/config/env.server';
import { AppendOnlyViolationError } from '@/server/errors';

/**
 * Compliance tables. Records may be inserted and read, never rewritten.
 *
 * This is enforced in two independent places: here, and by database triggers
 * installed in the migration `append_only_guards`. The database is the real
 * boundary — this guard exists so a violation fails fast with a clear error
 * during development rather than as an opaque SQL exception.
 */
export const APPEND_ONLY_MODELS: ReadonlySet<string> = new Set([
  'ChangeLog',
  'AuditEvent',
  'PolicyViolation',
]);

const MUTATING_OPERATIONS: ReadonlySet<string> = new Set([
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

  const base = new PrismaClient({
    adapter,
    log: isProduction
      ? [{ emit: 'event', level: 'error' }]
      : [
          { emit: 'event', level: 'error' },
          { emit: 'event', level: 'warn' },
        ],
  });

  return base.$extends({
    name: 'append-only-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (APPEND_ONLY_MODELS.has(model) && MUTATING_OPERATIONS.has(operation)) {
            throw new AppendOnlyViolationError(model, operation);
          }
          return query(args);
        },
      },
    },
  });
}

export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

// Next.js dev server hot-reloads modules on every edit. Without this cache each
// reload would open a fresh connection pool until Postgres refuses new clients.
const globalForPrisma = globalThis as unknown as {
  __gbpPrisma?: ExtendedPrismaClient;
};

export const prisma: ExtendedPrismaClient =
  globalForPrisma.__gbpPrisma ?? createPrismaClient();

if (!isProduction) {
  globalForPrisma.__gbpPrisma = prisma;
}
