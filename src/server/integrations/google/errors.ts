/**
 * Typed errors for the Google Business Profile APIs.
 *
 * Callers branch on error CLASS, never on message text or raw status codes.
 * Each class implies a different recovery: retry, defer, reconnect, or give up.
 */

export type GbpErrorKind =
  | 'auth'
  | 'permission'
  | 'quota'
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'transient'
  | 'unknown';

export abstract class GbpError extends Error {
  abstract readonly kind: GbpErrorKind;
  /** Whether retrying the identical request could plausibly succeed. */
  abstract readonly retryable: boolean;

  readonly status?: number;
  readonly googleReason?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    options: { status?: number; googleReason?: string; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.googleReason = options.googleReason;
    this.details = options.details;
  }
}

/** Token expired, revoked, or rejected. The connection must be re-authorized. */
export class GbpAuthError extends GbpError {
  readonly kind = 'auth' as const;
  readonly retryable = false;
}

/** Authenticated, but this account cannot act on that resource. */
export class GbpPermissionError extends GbpError {
  readonly kind = 'permission' as const;
  readonly retryable = false;
}

/**
 * Rate or quota limit. Retryable, but only after a delay — never immediately.
 * Note the platform's own governor should normally prevent this being reached.
 */
export class GbpQuotaError extends GbpError {
  readonly kind = 'quota' as const;
  readonly retryable = true;
  readonly retryAfterMs: number;

  constructor(message: string, options: ConstructorParameters<typeof GbpError>[1] & { retryAfterMs?: number } = {}) {
    super(message, options);
    this.retryAfterMs = options.retryAfterMs ?? 60_000;
  }
}

/** Google rejected the payload. Retrying unchanged will fail identically. */
export class GbpValidationError extends GbpError {
  readonly kind = 'validation' as const;
  readonly retryable = false;
}

export class GbpNotFoundError extends GbpError {
  readonly kind = 'not_found' as const;
  readonly retryable = false;
}

export class GbpConflictError extends GbpError {
  readonly kind = 'conflict' as const;
  readonly retryable = false;
}

/** Network failure, timeout, or 5xx. Safe to retry with backoff. */
export class GbpTransientError extends GbpError {
  readonly kind = 'transient' as const;
  readonly retryable = true;
}

export class GbpUnknownError extends GbpError {
  readonly kind = 'unknown' as const;
  readonly retryable = false;
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: unknown;
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

/**
 * Maps an HTTP response into the taxonomy above.
 *
 * 403 is deliberately split: Google returns it both for genuine permission
 * problems and for quota exhaustion, and the two need opposite handling
 * (give up vs. back off and retry). The `reason` field is what distinguishes them.
 */
export function mapGoogleHttpError(
  status: number,
  body: unknown,
  retryAfterHeader?: string | null,
): GbpError {
  const parsed = (body ?? {}) as GoogleErrorBody;
  const message = parsed.error?.message ?? `Google API request failed with status ${status}`;
  const reason = parsed.error?.errors?.[0]?.reason ?? parsed.error?.status;
  const details = parsed.error?.details ?? parsed.error?.errors;
  const options = { status, googleReason: reason, details };

  const retryAfterMs = retryAfterHeader
    ? Number.parseInt(retryAfterHeader, 10) * 1000
    : undefined;

  switch (status) {
    case 400:
      return new GbpValidationError(message, options);
    case 401:
      return new GbpAuthError(message, options);
    case 403: {
      const quotaReasons = ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'];
      if (reason && quotaReasons.includes(reason)) {
        return new GbpQuotaError(message, { ...options, retryAfterMs });
      }
      return new GbpPermissionError(message, options);
    }
    case 404:
      return new GbpNotFoundError(message, options);
    case 409:
      return new GbpConflictError(message, options);
    case 429:
      return new GbpQuotaError(message, { ...options, retryAfterMs });
    default:
      if (status >= 500) return new GbpTransientError(message, options);
      return new GbpUnknownError(message, options);
  }
}

export function isGbpError(error: unknown): error is GbpError {
  return error instanceof GbpError;
}
