/**
 * Browser-visible configuration.
 *
 * Every value here is inlined into the client bundle at build time and is
 * therefore PUBLIC. Never add a secret, token, key, or connection string.
 *
 * Next.js only inlines statically-analyzable `process.env.NEXT_PUBLIC_*`
 * references, so these must be written out in full rather than looked up
 * dynamically.
 */

import { z } from 'zod';

const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
  NEXT_PUBLIC_SENTRY_DSN: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().optional(),
  ),
});

const parsed = clientEnvSchema.safeParse({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
});

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid public environment configuration:\n${issues}`);
}

export const clientEnv = parsed.data;
export type ClientEnv = typeof clientEnv;
