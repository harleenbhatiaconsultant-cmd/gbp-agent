/**
 * Health and readiness reporting.
 *
 * Lives in the service layer because route handlers must not touch Prisma
 * directly — the same boundary that applies to product features applies to
 * infrastructure endpoints.
 */

import { prisma } from '@/server/db';
import { env, isProduction } from '@/config/env.server';
import { getWriteMode, features } from '@/config/features';
import { childLogger } from '@/server/observability/logger';

export interface DependencyHealth {
  name: string;
  status: 'ok' | 'degraded' | 'unconfigured' | 'error';
  detail?: string;
  latencyMs?: number;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  environment: string;
  /** Surfaced deliberately: an operator should be able to see at a glance
   *  whether this process can mutate real customer profiles. */
  gbpWriteMode: string;
  autoApplyEnabled: boolean;
  dependencies: DependencyHealth[];
  checkedAt: string;
}

async function checkDatabase(): Promise<DependencyHealth> {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { name: 'postgres', status: 'ok', latencyMs: Date.now() - startedAt };
  } catch (error) {
    childLogger({ dependency: 'postgres' }).error(
      { err: error },
      'Database health check failed',
    );
    return {
      name: 'postgres',
      status: 'error',
      detail: 'Unable to reach the database.',
      latencyMs: Date.now() - startedAt,
    };
  }
}

function checkRedis(): DependencyHealth {
  // Phase 4. Reported as unconfigured rather than failing, so Phase 0-3 stay green.
  if (!env.REDIS_URL) {
    return {
      name: 'redis',
      status: 'unconfigured',
      detail: 'REDIS_URL not set; the background job layer is not active yet (Phase 4).',
    };
  }
  return { name: 'redis', status: 'ok' };
}

function checkGoogleOAuth(): DependencyHealth {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return {
      name: 'google-oauth',
      status: 'unconfigured',
      detail:
        'Google OAuth client credentials not set; profile connection is unavailable (Phase 2).',
    };
  }
  if (!env.TOKEN_ENCRYPTION_KEY) {
    return {
      name: 'google-oauth',
      status: 'degraded',
      detail:
        'OAuth credentials are present but TOKEN_ENCRYPTION_KEY is missing; connections cannot be stored.',
    };
  }
  return { name: 'google-oauth', status: 'ok' };
}

export async function getHealthReport(): Promise<HealthReport> {
  const dependencies: DependencyHealth[] = [
    await checkDatabase(),
    checkRedis(),
    checkGoogleOAuth(),
  ];

  const hasError = dependencies.some((d) => d.status === 'error');
  const hasDegraded = dependencies.some((d) => d.status === 'degraded');

  return {
    status: hasError ? 'error' : hasDegraded ? 'degraded' : 'ok',
    environment: isProduction ? 'production' : env.NODE_ENV,
    gbpWriteMode: getWriteMode(),
    autoApplyEnabled: features.autoApply,
    dependencies,
    checkedAt: new Date().toISOString(),
  };
}
