/**
 * HTTP transport for the Google Business Profile APIs.
 *
 * Every outbound call goes through here so that timeout, bounded retry with
 * jitter, and error mapping are applied uniformly. No caller issues a bare
 * `fetch` to Google.
 *
 * Retry policy: only errors marked `retryable` are retried, and quota errors
 * wait for the interval Google asked for. A validation error is never retried —
 * the identical request would fail identically, and retrying it burns quota.
 */

import { logger } from '@/server/observability/logger';
import {
  GbpTransientError,
  isGbpError,
  mapGoogleHttpError,
  type GbpError,
} from '@/server/integrations/google/errors';

export const GOOGLE_API_HOSTS = {
  accountManagement: 'https://mybusinessaccountmanagement.googleapis.com',
  businessInformation: 'https://mybusinessbusinessinformation.googleapis.com',
  performance: 'https://businessprofileperformance.googleapis.com',
  notifications: 'https://mybusinessnotifications.googleapis.com',
  verifications: 'https://mybusinessverifications.googleapis.com',
  /**
   * Reviews and local posts were never migrated off the legacy v4.9 API, so two
   * API generations must coexist. This is not an oversight.
   */
  legacyV4: 'https://mybusiness.googleapis.com',
} as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

export interface GoogleRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  accessToken: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  /** Correlation fields for logging. Never include tokens. */
  logContext?: Record<string, unknown>;
}

function buildUrl(url: string, query?: GoogleRequestOptions['query']): string {
  if (!query) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

function backoffDelayMs(attempt: number, error: GbpError): number {
  if (error.kind === 'quota' && 'retryAfterMs' in error) {
    return (error as GbpError & { retryAfterMs: number }).retryAfterMs;
  }
  const base = 500 * 2 ** (attempt - 1);
  // Jitter prevents a fleet of workers retrying in lockstep after an outage.
  return base + Math.floor(Math.random() * 250);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function googleRequest<T>(
  url: string,
  options: GoogleRequestOptions,
): Promise<T> {
  const method = options.method ?? 'GET';
  const target = buildUrl(url, options.query);
  const log = logger.child({ googleMethod: method, ...options.logContext });

  let lastError: GbpError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(target, {
        method,
        headers: {
          Authorization: `Bearer ${options.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      let errorBody: unknown;
      try {
        errorBody = JSON.parse(await response.text());
      } catch {
        errorBody = undefined;
      }

      const mapped = mapGoogleHttpError(
        response.status,
        errorBody,
        response.headers.get('retry-after'),
      );
      lastError = mapped;

      if (!mapped.retryable || attempt === MAX_ATTEMPTS) throw mapped;

      const delay = backoffDelayMs(attempt, mapped);
      log.warn(
        { attempt, status: response.status, kind: mapped.kind, delayMs: delay },
        'Google API call failed, retrying',
      );
      await sleep(delay);
    } catch (error) {
      if (isGbpError(error)) {
        if (!error.retryable || attempt === MAX_ATTEMPTS) throw error;
        lastError = error;
        await sleep(backoffDelayMs(attempt, error));
        continue;
      }

      // Network failure, DNS, or the AbortSignal timeout.
      const transient = new GbpTransientError(
        error instanceof Error ? error.message : 'Network failure calling Google',
        { cause: error },
      );
      lastError = transient;

      if (attempt === MAX_ATTEMPTS) throw transient;
      const delay = backoffDelayMs(attempt, transient);
      log.warn({ attempt, delayMs: delay }, 'Network error calling Google, retrying');
      await sleep(delay);
    }
  }

  throw lastError ?? new GbpTransientError('Google API call failed after retries.');
}

/**
 * Follows `nextPageToken` until exhausted.
 *
 * `maxPages` is a guard rather than a preference: a pagination bug against an
 * API with per-minute quota would otherwise spend the entire budget in seconds.
 */
export async function paginate<TItem, TResponse extends { nextPageToken?: string }>(
  fetchPage: (pageToken?: string) => Promise<TResponse>,
  extract: (response: TResponse) => TItem[] | undefined,
  maxPages = 20,
): Promise<TItem[]> {
  const items: TItem[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await fetchPage(pageToken);
    items.push(...(extract(response) ?? []));
    pageToken = response.nextPageToken;
    if (!pageToken) return items;
  }

  logger.warn({ maxPages, collected: items.length }, 'Pagination hit its page cap');
  return items;
}
