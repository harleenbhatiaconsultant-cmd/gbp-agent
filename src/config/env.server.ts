/**
 * Server-side environment configuration.
 *
 * Parsed and validated once at process boot. A malformed or missing required
 * variable fails the process immediately rather than surfacing as a confusing
 * runtime error hours later.
 *
 * WHY NO `server-only` IMPORT HERE:
 * The `server-only` package throws when resolved outside a React Server
 * Component graph — which includes the standalone worker and scheduler
 * processes that legitimately need this module. Instead this file uses an
 * explicit runtime browser guard (below), and the ESLint `no-restricted-imports`
 * zones in eslint.config.mjs prevent client components from importing it at all.
 *
 * NEVER add a variable here that should reach the browser. Browser-visible
 * config lives in env.client.ts and must be prefixed NEXT_PUBLIC_.
 */

import { z } from 'zod';

if (typeof window !== 'undefined') {
  throw new Error(
    'env.server.ts was imported in a browser bundle. Server configuration must never reach the client. ' +
      'Use @/config/env.client for browser-visible values.',
  );
}

// ---------------------------------------------------------------------------
// Coercion helpers — environment variables are always strings or undefined.
// ---------------------------------------------------------------------------

const zBool = (defaultValue: boolean) =>
  z.preprocess(
    (v) =>
      v === undefined || v === ''
        ? defaultValue
        : ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase()),
    z.boolean(),
  );

const zInt = (defaultValue: number) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? defaultValue : Number(v)),
    z.number().int(),
  );

const zOptionalString = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().optional(),
);

/** A 32-byte key, base64-encoded. Used for AES-256-GCM. */
const zBase64Key32 = z
  .string()
  .refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'must be exactly 32 bytes, base64-encoded (generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))")' },
  );

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const envSchema = z.object({
  // Core -------------------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.url().default('http://localhost:3000'),
  NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  // Database ---------------------------------------------------------------
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: zOptionalString,

  // Redis (Phase 4 — managed Upstash). Empty until the instance exists.
  REDIS_URL: zOptionalString,
  QUEUE_PREFIX: z.string().default('gbp'),
  WORKER_CONCURRENCY: zInt(5),

  // Auth (Phase 1) ---------------------------------------------------------
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  AUTH_URL: z.url().default('http://localhost:3000'),
  AUTH_TRUST_HOST: zBool(false),
  GOOGLE_LOGIN_CLIENT_ID: zOptionalString,
  GOOGLE_LOGIN_CLIENT_SECRET: zOptionalString,

  // Google Business Profile OAuth (Phase 2) --------------------------------
  GOOGLE_OAUTH_CLIENT_ID: zOptionalString,
  GOOGLE_OAUTH_CLIENT_SECRET: zOptionalString,
  GOOGLE_OAUTH_REDIRECT_URI: z
    .url()
    .default('http://localhost:3000/api/google/oauth/callback'),
  GOOGLE_OAUTH_SCOPES: z
    .string()
    .default('https://www.googleapis.com/auth/business.manage'),
  GOOGLE_CLOUD_PROJECT_ID: zOptionalString,

  // GBP write safety -------------------------------------------------------
  // `validate_only` sends every write to Google with validateOnly=true.
  // Nothing is mutated. This is the default and must stay the default.
  GBP_WRITE_MODE: z.enum(['validate_only', 'live']).default('validate_only'),
  GBP_MAX_EDITS_PER_MINUTE: zInt(10),
  GBP_MAX_QPM: zInt(300),
  GBP_MAX_CHANGES_PER_LOCATION_PER_DAY: zInt(10),

  // Token encryption (required once Google connections exist) --------------
  // Optional at boot so Phase 0/1 can run without it; `requireTokenEncryptionKey()`
  // throws at the point of use if it is missing.
  TOKEN_ENCRYPTION_KEY: zBase64Key32.optional(),
  TOKEN_ENCRYPTION_KEY_VERSION: zInt(1),

  // Pub/Sub (Phase 7) ------------------------------------------------------
  GBP_PUBSUB_TOPIC: zOptionalString,
  GBP_PUBSUB_PUSH_AUDIENCE: zOptionalString,
  GBP_PUBSUB_VERIFICATION_TOKEN: zOptionalString,
  GOOGLE_APPLICATION_CREDENTIALS: zOptionalString,

  // AI (Phase 5/6) ---------------------------------------------------------
  AI_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  ANTHROPIC_API_KEY: zOptionalString,
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),
  ANTHROPIC_FAST_MODEL: z.string().default('claude-haiku-4-5'),
  OPENAI_API_KEY: zOptionalString,
  OPENAI_MODEL: zOptionalString,
  AI_MONTHLY_BUDGET_USD: zInt(100),
  AI_REQUEST_TIMEOUT_MS: zInt(60_000),

  // Rank tracking (Phase 10) ----------------------------------------------
  RANK_PROVIDER: z.enum(['dataforseo', 'serpapi', 'none']).default('none'),
  DATAFORSEO_LOGIN: zOptionalString,
  DATAFORSEO_PASSWORD: zOptionalString,
  SERPAPI_KEY: zOptionalString,
  RANK_GRID_DEFAULT_SIZE: zInt(7),
  RANK_GRID_DEFAULT_RADIUS_M: zInt(5000),
  RANK_SCAN_MAX_PER_DAY: zInt(50),

  // Crawler (Phase 11) -----------------------------------------------------
  CRAWLER_USER_AGENT: z.string().default('GBPGrowthAgentBot/1.0'),
  CRAWLER_MAX_PAGES: zInt(200),
  CRAWLER_TIMEOUT_MS: zInt(15_000),
  CRAWLER_CONCURRENCY: zInt(3),
  CRAWLER_RESPECT_ROBOTS: zBool(true),
  PAGESPEED_API_KEY: zOptionalString,
  GOOGLE_SEARCH_CONSOLE_ENABLED: zBool(false),
  GOOGLE_PLACES_API_KEY: zOptionalString,

  // Notifications ----------------------------------------------------------
  EMAIL_FROM: zOptionalString,
  RESEND_API_KEY: zOptionalString,
  SLACK_WEBHOOK_URL: zOptionalString,

  // Billing (Phase 14) -----------------------------------------------------
  STRIPE_SECRET_KEY: zOptionalString,
  STRIPE_WEBHOOK_SECRET: zOptionalString,

  // Observability ----------------------------------------------------------
  SENTRY_DSN: zOptionalString,
  SENTRY_ENVIRONMENT: z.string().default('development'),

  // Scheduler --------------------------------------------------------------
  CRON_SECRET: zOptionalString,

  // Feature flags ----------------------------------------------------------
  // ENABLE_AUTO_APPLY is the master switch for unattended profile changes.
  // It is false by default and is only one of three conditions required before
  // any change executes unattended — see src/config/features.ts.
  ENABLE_AUTO_APPLY: zBool(false),
  ENABLE_POSTS: zBool(false),
  ENABLE_RANK_TRACKING: zBool(false),
  ENABLE_COMPETITORS: zBool(false),
  ENABLE_WEBSITE_AUDIT: zBool(false),
  ENABLE_REPORTS: zBool(false),
  ENABLE_WHITE_LABEL: zBool(false),
  ENABLE_BILLING: zBool(false),
});

export type ServerEnv = z.infer<typeof envSchema>;

// ---------------------------------------------------------------------------
// Parse once, fail fast
// ---------------------------------------------------------------------------

function parseEnv(): ServerEnv {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid server environment configuration:\n${issues}\n\n` +
        'Copy .env.example to .env and fill in the required values.',
    );
  }

  const parsed = result.data;

  // ---- Cross-field safety invariants ------------------------------------

  // Live writes mutate real customer business profiles. Google has no sandbox,
  // so this guard makes it impossible to point a dev or test process at live mode.
  if (parsed.GBP_WRITE_MODE === 'live' && parsed.NODE_ENV !== 'production') {
    throw new Error(
      `GBP_WRITE_MODE=live is only permitted when NODE_ENV=production (got NODE_ENV=${parsed.NODE_ENV}). ` +
        'Live mode performs real, irreversible writes to customer Google Business Profiles.',
    );
  }

  // Unattended writes require live mode to mean anything, and must never be
  // switched on outside production by accident.
  if (parsed.ENABLE_AUTO_APPLY && parsed.NODE_ENV !== 'production') {
    throw new Error(
      `ENABLE_AUTO_APPLY=true is only permitted when NODE_ENV=production (got NODE_ENV=${parsed.NODE_ENV}).`,
    );
  }

  return parsed;
}

export const env: ServerEnv = parseEnv();

// ---------------------------------------------------------------------------
// Accessors for values that are optional at boot but required at point of use
// ---------------------------------------------------------------------------

/**
 * Returns the AES-256-GCM key for OAuth token encryption.
 * Throws if unset — call this only where a token is actually being sealed
 * or opened, so Phase 0/1 can boot without Google credentials configured.
 */
export function requireTokenEncryptionKey(): Buffer {
  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is not set. It is required before any Google connection ' +
        'can be stored. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');
}

/** Google OAuth client credentials, required from Phase 2 onward. */
export function requireGoogleOAuthCredentials(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
} {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are required to connect a ' +
        'Google Business Profile. Create an OAuth 2.0 Web application client in the Google Cloud Console.',
    );
  }
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
    scopes: env.GOOGLE_OAUTH_SCOPES.split(/[\s,]+/).filter(Boolean),
  };
}

/** Redis connection string, required from Phase 4 onward. */
export function requireRedisUrl(): string {
  if (!env.REDIS_URL) {
    throw new Error(
      'REDIS_URL is not set. The background job layer requires a Redis instance ' +
        '(managed Upstash for this project). Paste the rediss:// URL into .env.',
    );
  }
  return env.REDIS_URL;
}

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
