/**
 * Worker process entrypoint.
 *
 * Deployed as its own Railway service, separate from `web`. It owns every
 * outbound Google API call, audit run, AI call, crawl and change execution.
 *
 * Why a separate process (ARCHITECTURE.md §1.1): GBP writes are rate-limited to
 * roughly 10 edits/minute per profile, are long-running, and must be retryable
 * with idempotency. Running them inside an HTTP request handler would couple
 * correctness to request timeouts.
 *
 * PHASE 0: this process boots, validates configuration, and verifies database
 * connectivity. Queue consumers arrive in Phase 4 once Redis is provisioned.
 */

import 'dotenv/config';

process.env.SERVICE_NAME ??= 'worker';

import { env } from '@/config/env.server';
import { getWriteMode } from '@/config/features';
import { prisma } from '@/server/db';
import { logger } from '@/server/observability/logger';

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

  if (!env.REDIS_URL) {
    logger.warn(
      'REDIS_URL is not set — no queues to consume. This is expected until Phase 4; ' +
        'the worker will idle. Paste the Upstash connection string into .env to activate it.',
    );
  }

  // Phase 4 registers BullMQ workers here.

  logger.info('Worker ready (idle: no queues registered yet)');
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Worker shutting down');
  try {
    // Phase 4: close queue consumers here before the database, so in-flight
    // jobs finish rather than being killed mid-write.
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
  logger.fatal({ err: reason }, 'Unhandled rejection in worker');
  process.exit(1);
});

main().catch((error) => {
  logger.fatal({ err: error }, 'Worker failed to start');
  process.exit(1);
});
