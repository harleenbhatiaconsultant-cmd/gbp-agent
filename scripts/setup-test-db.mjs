/**
 * Creates/updates the test database schema.
 *
 * Exists as a script rather than an inline `DATABASE_URL=... prisma migrate`
 * because that syntax does not work in cmd.exe on Windows, and this project is
 * developed on Windows and deployed on Linux.
 *
 * Usage: npm run db:setup:test
 */

import { execFileSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';

// .env.test first — dotenv never overwrites an already-set variable, so
// whichever file loads first wins.
loadEnv({ path: '.env.test', quiet: true });
loadEnv({ path: '.env', quiet: true });

const url = process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL is not set. Expected it in .env.test');
  process.exit(1);
}

if (!url.includes('_test')) {
  console.error(
    `Refusing to run: DATABASE_URL does not look like a test database (${url}).\n` +
      'This script applies migrations and must never target development or production data.',
  );
  process.exit(1);
}

console.log(`Applying migrations to ${url.replace(/:[^:@/]*@/, ':***@')}`);

execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: process.env,
  shell: true,
});
