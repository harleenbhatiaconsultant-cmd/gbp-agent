/**
 * Redis connection management.
 *
 * The whole job layer is OPTIONAL infrastructure: the platform runs without it,
 * with scheduled work simply not happening. That is deliberate — it lets the
 * web app boot, audits run on demand, and the product be used before Redis is
 * provisioned, rather than making a queue a hard dependency of signing in.
 *
 * Connections are lazy and shared. BullMQ needs several clients per queue, and
 * Upstash bills by command, so creating a fresh connection per call would be
 * both slow and expensive.
 */

import IORedis, { type Redis } from 'ioredis';
import { env } from '@/config/env.server';
import { logger } from '@/server/observability/logger';

let sharedConnection: Redis | null = null;
let warnedAboutMissingRedis = false;

export function isQueueingAvailable(): boolean {
  return Boolean(env.REDIS_URL);
}

/**
 * Returns the shared Redis connection, or null when REDIS_URL is unset.
 *
 * Callers must handle null rather than assume a connection: that is what keeps
 * the platform usable before the queue exists.
 */
export function getRedisConnection(): Redis | null {
  if (!env.REDIS_URL) {
    if (!warnedAboutMissingRedis) {
      warnedAboutMissingRedis = true;
      logger.warn(
        'REDIS_URL is not set. Background jobs and scheduling are inactive; ' +
          'on-demand work still runs normally.',
      );
    }
    return null;
  }

  if (sharedConnection) return sharedConnection;

  sharedConnection = new IORedis(env.REDIS_URL, {
    // BullMQ requires this: with a retry limit, a blocking command that outlives
    // the limit throws instead of reconnecting, and workers die silently.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Upstash and most managed providers terminate idle connections; keep-alive
    // plus reconnect-on-error avoids a worker going quiet after a lull.
    keepAlive: 30_000,
    retryStrategy(times) {
      const delay = Math.min(times * 500, 10_000);
      logger.warn({ attempt: times, delayMs: delay }, 'Redis connection retrying');
      return delay;
    },
  });

  sharedConnection.on('error', (error) => {
    logger.error({ err: error }, 'Redis connection error');
  });

  sharedConnection.on('ready', () => {
    logger.info('Redis connection ready');
  });

  return sharedConnection;
}

/**
 * Verifies the connection actually works. Used by health checks and startup.
 *
 * BOUNDED BY A TIMEOUT, deliberately. The retry strategy above reconnects
 * forever, which is what you want for a long-running worker riding out a blip —
 * but it means a command issued against an unreachable server queues rather
 * than rejecting. Without this timeout a misconfigured REDIS_URL would leave
 * the worker hung at startup, looking alive while processing nothing. Failing
 * loudly lets the orchestrator restart it and lets a health check go red.
 */
export async function pingRedis(
  timeoutMs = 5_000,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const connection = getRedisConnection();
  if (!connection) return { ok: false, error: 'REDIS_URL is not set' };

  const startedAt = Date.now();

  try {
    await Promise.race([
      connection.ping(),
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`Redis did not respond within ${timeoutMs}ms`)),
          timeoutMs,
        ).unref?.(),
      ),
    ]);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Redis ping failed',
    };
  }
}

export async function closeRedisConnection(): Promise<void> {
  if (!sharedConnection) return;
  try {
    await sharedConnection.quit();
  } catch {
    sharedConnection.disconnect();
  } finally {
    sharedConnection = null;
  }
}
