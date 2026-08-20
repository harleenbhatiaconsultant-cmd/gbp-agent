/**
 * Structured logging.
 *
 * Every log line is JSON with a correlation id so a request or job can be
 * followed across the web and worker processes.
 *
 * REDACTION IS NOT OPTIONAL. OAuth tokens, encryption keys and API secrets must
 * never reach a log sink — logs are routinely shipped to third parties and kept
 * far longer than the credentials themselves. The redaction paths below are
 * deliberately broad; add to them when a new secret-bearing field appears.
 */

import pino, { type Logger } from 'pino';
import { env, isProduction } from '@/config/env.server';

const REDACT_PATHS = [
  // Direct secret fields, at any nesting depth commonly used in this codebase.
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'encryptedRefreshToken',
  'clientSecret',
  'client_secret',
  'keyHash',
  'tokenHash',
  'sessionToken',
  'TOKEN_ENCRYPTION_KEY',
  'AUTH_SECRET',
  'DATABASE_URL',

  // Common request/response envelopes.
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',

  // One level of nesting for the shapes we log most often.
  '*.password',
  '*.token',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.encryptedRefreshToken',
  '*.clientSecret',
  '*.apiKey',
];

/**
 * pino's `transport` option spawns a worker thread, which does not survive
 * Next.js bundling. Pretty output is therefore enabled only in standalone Node
 * processes (worker, scheduler, scripts); Next.js emits plain JSON.
 */
function shouldUsePrettyTransport(): boolean {
  return !isProduction && process.env.NEXT_RUNTIME === undefined;
}

function createRootLogger(): Logger {
  const base = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: {
      env: env.NODE_ENV,
    },
    /**
     * `service` is resolved per log call rather than baked into `base`.
     *
     * ES module imports are hoisted, so an entrypoint that sets
     * `process.env.SERVICE_NAME` in its body runs AFTER this module has already
     * been evaluated. Reading it here means the worker and scheduler are
     * labelled correctly without either entrypoint needing a bootstrap shim.
     */
    mixin: () => ({ service: process.env.SERVICE_NAME ?? 'web' }),
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  };

  if (shouldUsePrettyTransport()) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(base);
}

export const logger: Logger = createRootLogger();

/**
 * Child logger bound to a unit of work.
 *
 * Always pass `organizationId` when the work is tenant-scoped — it makes
 * per-customer debugging and incident scoping possible.
 */
export function childLogger(bindings: {
  requestId?: string;
  jobId?: string;
  organizationId?: string;
  locationId?: string;
  userId?: string;
  [key: string]: unknown;
}): Logger {
  return logger.child(bindings);
}

export type { Logger };
