/**
 * Application error taxonomy.
 *
 * Callers branch on error *type*, never on message strings. Every error carries
 * a stable `code` for logging and an `httpStatus` so route handlers can map an
 * error to a response without a chain of instanceof checks at the edge.
 *
 * `expose` marks errors whose message is safe to show a user. Anything false is
 * logged in full but returned to the client as a generic message — internal
 * detail (SQL, upstream payloads, resource existence) must not leak.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TENANT_ISOLATION'
  | 'APPEND_ONLY_VIOLATION'
  | 'POLICY_BLOCKED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_AUTH'
  | 'UPSTREAM_QUOTA'
  | 'UPSTREAM_VALIDATION'
  | 'UPSTREAM_UNAVAILABLE'
  | 'CONFIGURATION'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly expose: boolean;
  readonly context?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      httpStatus?: number;
      expose?: boolean;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = options.httpStatus ?? 500;
    this.expose = options.expose ?? false;
    this.context = options.context;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('BAD_REQUEST', message, { httpStatus: 400, expose: true, context });
  }
}

export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('VALIDATION_FAILED', message, { httpStatus: 422, expose: true, context });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required.') {
    super('UNAUTHENTICATED', message, { httpStatus: 401, expose: true });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.', context?: Record<string, unknown>) {
    super('FORBIDDEN', message, { httpStatus: 403, expose: true, context });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.', context?: Record<string, unknown>) {
    super('NOT_FOUND', message, { httpStatus: 404, expose: true, context });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('CONFLICT', message, { httpStatus: 409, expose: true, context });
  }
}

/**
 * A query attempted to reach a resource belonging to a different organization.
 *
 * Deliberately surfaces as 404, not 403: confirming that a resource exists in
 * another tenant is itself an information leak.
 */
export class TenantIsolationError extends AppError {
  constructor(model: string, context?: Record<string, unknown>) {
    super('TENANT_ISOLATION', `Resource not found.`, {
      httpStatus: 404,
      expose: true,
      context: { model, ...context },
    });
  }
}

/** An update or delete was attempted against an append-only compliance table. */
export class AppendOnlyViolationError extends AppError {
  constructor(model: string, operation: string) {
    super(
      'APPEND_ONLY_VIOLATION',
      `${model} is append-only; "${operation}" is not permitted. ` +
        'These records are the platform compliance trail and must never be rewritten.',
      { httpStatus: 500, expose: false, context: { model, operation } },
    );
  }
}

/** A compliance guardrail refused the request. */
export class PolicyBlockedError extends AppError {
  constructor(ruleId: string, message: string, context?: Record<string, unknown>) {
    super('POLICY_BLOCKED', message, {
      httpStatus: 422,
      expose: true,
      context: { ruleId, ...context },
    });
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('CONFIGURATION', message, { httpStatus: 500, expose: false, context });
  }
}

/** Narrowing helper for catch blocks. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Converts any thrown value into a client-safe shape.
 * Non-exposed errors collapse to a generic message; the original is logged separately.
 */
export function toClientError(error: unknown): {
  code: ErrorCode;
  message: string;
  httpStatus: number;
} {
  if (isAppError(error)) {
    return {
      code: error.code,
      message: error.expose ? error.message : 'Something went wrong.',
      httpStatus: error.httpStatus,
    };
  }
  return { code: 'INTERNAL', message: 'Something went wrong.', httpStatus: 500 };
}
