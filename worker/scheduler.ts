/**
 * Scheduler process entrypoint.
 *
 * Deployed as its own Railway service. Its only job is to enqueue recurring
 * work — daily location sync, weekly audits, rank scans, token refresh sweeps —
 * and then get out of the way. It performs no work itself, so a scheduler
 * restart can never interrupt an in-flight change execution.
 *
 * Enqueued jobs are keyed (`${type}:${locationId}:${bucket}`) so a restart
 * cannot double-enqueue the same unit of work.
 *
 * PHASE 0: boots and validates configuration. Repeatable job registration
 * arrives in Phase 4 with Redis.
 */

import 'dotenv/config';

process.env.SERVICE_NAME ??= 'scheduler';

import { env } from '@/config/env.server';
import { prisma } from '@/server/db';
import { logger } from '@/server/observability/logger';

async function main(): Promise<void> {
  logger.info({ nodeEnv: env.NODE_ENV }, 'Scheduler starting');

  await prisma.$queryRaw`SELECT 1`;
  logger.info('Database connection verified');

  if (!env.REDIS_URL) {
    logger.warn(
      'REDIS_URL is not set — no schedules registered. Expected until Phase 4.',
    );
  }

  // Phase 4 registers BullMQ repeatable jobs here.

  logger.info('Scheduler ready (idle: no schedules registered yet)');
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Scheduler shutting down');
  try {
    await prisma.$disconnect();
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection in scheduler');
  process.exit(1);
});

main().catch((error) => {
  logger.fatal({ err: error }, 'Scheduler failed to start');
  process.exit(1);
});
