/**
 * Scheduler process entrypoint.
 *
 * Deployed as its own Railway service, PINNED TO ONE REPLICA. Its only job is
 * to register recurring work and then get out of the way — it performs no work
 * itself, so a scheduler restart can never interrupt an in-flight change.
 *
 * Two replicas would each register the same repeatable jobs and every schedule
 * would fire twice. The deployment doc says this; it is repeated here because
 * this is the file someone will be looking at when they scale it.
 */

import 'dotenv/config';

process.env.SERVICE_NAME ??= 'scheduler';

import { env } from '@/config/env.server';
import { prisma } from '@/server/db';
import { logger } from '@/server/observability/logger';
import { pingRedis, closeRedisConnection, isQueueingAvailable } from '@/server/jobs/redis';
import { registerSchedules, listRegisteredSchedules } from '@/server/jobs/schedules';
import { closeQueues } from '@/server/jobs/queues';

let shuttingDown = false;

async function main(): Promise<void> {
  logger.info({ nodeEnv: env.NODE_ENV }, 'Scheduler starting');

  await prisma.$queryRaw`SELECT 1`;
  logger.info('Database connection verified');

  if (!isQueueingAvailable()) {
    logger.warn(
      'REDIS_URL is not set — no schedules registered. The scheduler will idle.',
    );
    logger.info('Scheduler ready (idle: queueing not configured)');
    return;
  }

  const ping = await pingRedis();
  if (!ping.ok) {
    throw new Error(`Redis is configured but unreachable: ${ping.error}`);
  }
  logger.info({ latencyMs: ping.latencyMs }, 'Redis connection verified');

  const result = await registerSchedules();
  const registered = await listRegisteredSchedules();

  for (const schedule of registered) {
    logger.info(
      { jobName: schedule.name, pattern: schedule.pattern, nextRun: schedule.next?.toISOString() },
      'Schedule active',
    );
  }

  logger.info(
    { registered: result.registered, removedObsolete: result.removed },
    'Scheduler ready',
  );
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Scheduler shutting down');
  try {
    await closeQueues();
    await closeRedisConnection();
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
