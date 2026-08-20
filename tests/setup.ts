/**
 * Vitest global setup.
 *
 * Loads .env.test FIRST so its values win: dotenv never overwrites a variable
 * that is already set, so whichever file is loaded first takes precedence.
 * This is what keeps tests pointed at the test database rather than dev data.
 */

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.test', quiet: true });
loadEnv({ path: '.env', quiet: true });

if (!process.env.DATABASE_URL?.includes('_test')) {
  throw new Error(
    `Refusing to run tests: DATABASE_URL does not point at a test database (got "${
      process.env.DATABASE_URL ?? '<unset>'
    }"). Tests create and delete rows, and must never run against development or production data.`,
  );
}
