/**
 * Worker process entrypoint.
 *
 * Deployed as its own Railway service, separate from `web`. It owns every
 * outbound Google API call, audit run, and change execution.
 *
 * Why a separate process (ARCHITECTURE.md §1.1): GBP writes are rate-limited to
 * roughly 10 edits/minute per profile, are long-running, and must be retryable
 * with idempotency. Running them inside an HTTP request handler would couple
 * correctness to request timeouts.
 *
 * Without REDIS_URL the process starts and idles rather than crashing, so the
 * deployment topology can exist before the queue does.
 */

import 'dotenv/config';

process.env.SERVICE_NAME ??= 'worker';

import { env } from '@/config/env.server';
import { getWriteMode } from '@/config/features';
import { prisma } from '@/server/db';
import { logger } from '@/server/observability/logger';
import { pingRedis, closeRedisConnection, isQueueingAvailable } from '@/server/jobs/redis';
import { startWorkers, stopWorkers } from '@/server/jobs/workers';
import { closeQueues } from '@/server/jobs/queues';

let shuttingDown = false;

async function main(): Promise<void> {
  logger.info(
    {
      nodeEnv: env.NODE_ENV,
      writeMode: getWriteMode(),
      concurrency: env.WORKER_CONCURRENCY,
    },
    'Worker starting',
  );

  await prisma.$queryRaw`SELECT 1`;
  logger.info('Database connection verified');

  if (!isQueueingAvailable()) {
    logger.warn(
      'REDIS_URL is not set — no queues to consume. The worker will idle. ' +
        'Paste the Upstash connection string into .env to activate it.',
    );
    logger.info('Worker ready (idle: queueing not configured)');
    return;
  }

  const ping = await pingRedis();
  if (!ping.ok) {
    // Fail loudly: a worker that cannot reach Redis will never process anything,
    // and looking healthy while doing nothing is the worst of both.
    throw new Error(`Redis is configured but unreachable: ${ping.error}`);
  }
  logger.info({ latencyMs: ping.latencyMs }, 'Redis connection verified');

  const started = startWorkers();
  logger.info({ workers: started, writeMode: getWriteMode() }, 'Worker ready');
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Worker shutting down');

  try {
    // Order matters: let in-flight jobs finish before the database goes away,
    // or a job mid-transaction is cut off partway through.
    await stopWorkers();
    await closeQueues();
    await closeRedisConnection();
    await prisma.$disconnect();
    logger.info('Worker shut down cleanly');
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection in worker');
  process.exit(1);
});

main().catch((error) => {
  logger.fatal({ err: error }, 'Worker failed to start');
  process.exit(1);
});
