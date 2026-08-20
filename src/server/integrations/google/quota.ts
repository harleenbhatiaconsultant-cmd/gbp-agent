/**
 * Google API quota governance.
 *
 * Google enforces two limits that matter here: a global request rate (default
 * ~300 QPM once API access is approved) and roughly 10 edits per minute per
 * profile on Business Information writes. Exceeding either gets requests
 * rejected, and repeated rejection is a good way to have access reviewed.
 *
 * The governor lives inside the provider so no caller can bypass it — a service
 * cannot forget to rate-limit, because it never sees the HTTP layer at all.
 *
 * Backed by Redis where available, so the limit holds across every worker and
 * web instance. Falls back to an in-process counter otherwise, which is correct
 * for a single instance and is the honest best-effort for local development.
 * Both use a fixed one-minute window: simple, cheap, and matching how Google
 * expresses the limits.
 */

import { env } from '@/config/env.server';
import { getRedisConnection } from '@/server/jobs/redis';
import { GbpQuotaError } from '@/server/integrations/google/errors';
import { logger } from '@/server/observability/logger';

const WINDOW_SECONDS = 60;

function currentWindow(): string {
  return String(Math.floor(Date.now() / (WINDOW_SECONDS * 1000)));
}

/** Milliseconds until the current window rolls over. */
function millisecondsUntilReset(): number {
  const windowMs = WINDOW_SECONDS * 1000;
  return windowMs - (Date.now() % windowMs);
}

// ---------------------------------------------------------------------------
// In-process fallback
// ---------------------------------------------------------------------------

const memoryCounters = new Map<string, number>();
let memoryWindow = currentWindow();

function incrementInMemory(key: string): number {
  const window = currentWindow();
  if (window !== memoryWindow) {
    memoryCounters.clear();
    memoryWindow = window;
  }
  const next = (memoryCounters.get(key) ?? 0) + 1;
  memoryCounters.set(key, next);
  return next;
}

// ---------------------------------------------------------------------------
// Governor
// ---------------------------------------------------------------------------

async function increment(key: string): Promise<number> {
  const connection = getRedisConnection();
  if (!connection) return incrementInMemory(key);

  const namespaced = `${env.QUEUE_PREFIX}:quota:${key}:${currentWindow()}`;

  try {
    const count = await connection.incr(namespaced);
    if (count === 1) {
      // Expire slightly after the window so a straggler cannot resurrect it.
      await connection.expire(namespaced, WINDOW_SECONDS + 10);
    }
    return count;
  } catch (error) {
    // A Redis blip must not stop legitimate work; degrade to the local counter
    // rather than refusing every request.
    logger.error({ err: error, key }, 'Quota check failed in Redis; using in-process counter');
    return incrementInMemory(key);
  }
}

export interface QuotaCheck {
  used: number;
  limit: number;
  retryAfterMs: number;
}

async function consume(key: string, limit: number, description: string): Promise<void> {
  const used = await increment(key);

  if (used > limit) {
    const retryAfterMs = millisecondsUntilReset();
    logger.warn({ key, used, limit, retryAfterMs }, 'Google API quota exhausted locally');

    throw new GbpQuotaError(
      `${description} rate limit reached (${used - 1}/${limit} in the last minute). ` +
        'Deferring rather than letting Google reject the request.',
      { retryAfterMs },
    );
  }
}

/**
 * Consumes one unit of the global request budget.
 * Applies to every call, read or write.
 */
export async function acquireRequestSlot(connectionId: string): Promise<void> {
  await consume(`req:${connectionId}`, env.GBP_MAX_QPM, 'Google API request');
}

/**
 * Consumes one unit of a single profile's edit budget.
 *
 * Called only for writes. Google's limit here is far tighter than the global
 * one, and it is per profile rather than per account.
 */
export async function acquireEditSlot(locationName: string): Promise<void> {
  await consume(
    `edit:${locationName}`,
    env.GBP_MAX_EDITS_PER_MINUTE,
    `Profile edit (${locationName})`,
  );
}

/** Current usage, for the ops view. Does not consume a slot. */
export async function peekQuota(connectionId: string): Promise<QuotaCheck> {
  const connection = getRedisConnection();
  const key = `req:${connectionId}`;

  let used = 0;
  if (connection) {
    const namespaced = `${env.QUEUE_PREFIX}:quota:${key}:${currentWindow()}`;
    const raw = await connection.get(namespaced).catch(() => null);
    used = raw ? Number.parseInt(raw, 10) : 0;
  } else {
    used = memoryCounters.get(key) ?? 0;
  }

  return { used, limit: env.GBP_MAX_QPM, retryAfterMs: millisecondsUntilReset() };
}

/** Test helper: clears the in-process counters. */
export function resetQuotaForTesting(): void {
  memoryCounters.clear();
  memoryWindow = currentWindow();
}
