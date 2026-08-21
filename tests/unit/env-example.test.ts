/**
 * The .env.example template must actually work.
 *
 * This exists because it did not. Cloning the published repo and following the
 * README exactly — `cp .env.example .env`, fill the required values, build —
 * failed with a boot error, because `TOKEN_ENCRYPTION_KEY=` in the template is
 * an empty STRING and `.optional()` only permits `undefined`.
 *
 * A template that does not parse is worse than no template: it is the
 * documented first step, so it fails on a fresh clone before the developer has
 * written anything, and the error points at a variable they were told to leave
 * blank.
 *
 * These tests exercise the template the way a new developer does, so it cannot
 * silently rot as the schema grows.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { validateEnv } from '@/config/env.server';

const template = parse(readFileSync(resolve(process.cwd(), '.env.example'), 'utf8'));

/** The two values the README tells you to fill in. Everything else stays as shipped. */
const filledIn = {
  ...template,
  DATABASE_URL: 'postgresql://postgres@localhost:5432/gbp_growth_agent?schema=public',
  AUTH_SECRET: 'a'.repeat(44),
};

describe('.env.example as shipped', () => {
  it('parses as a valid configuration once the required values are filled', () => {
    const result = validateEnv(filledIn);

    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('\n  ');
      expect.unreachable(
        `.env.example does not produce a valid config — a fresh clone cannot boot:\n  ${issues}`,
      );
    }

    expect(result.success).toBe(true);
  });

  it('leaves every optional credential blank rather than guessing a value', () => {
    // The template must not ship placeholder secrets that look real.
    for (const key of [
      'TOKEN_ENCRYPTION_KEY',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'ANTHROPIC_API_KEY',
      'STRIPE_SECRET_KEY',
    ]) {
      expect(template[key] ?? '', `${key} must ship blank`).toBe('');
    }
  });

  it('treats a blank optional credential as absent, not as a malformed one', () => {
    // The exact bug: '' is a string, and a schema expecting 32 base64 bytes
    // rejects it. Blank must mean "not configured".
    const result = validateEnv({ ...filledIn, TOKEN_ENCRYPTION_KEY: '' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.TOKEN_ENCRYPTION_KEY).toBeUndefined();
  });

  it('still rejects a genuinely malformed encryption key', () => {
    // Blank is fine; wrong is not. The fix must not have weakened validation.
    const result = validateEnv({ ...filledIn, TOKEN_ENCRYPTION_KEY: 'not-a-real-key' });
    expect(result.success).toBe(false);
  });

  it('ships the safety defaults in their safe positions', () => {
    const result = validateEnv(filledIn);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.GBP_WRITE_MODE).toBe('validate_only');
    expect(result.data.ENABLE_AUTO_APPLY).toBe(false);
  });

  it('leaves exactly one variable for the developer to generate', () => {
    // A required variable absent from the template is undiscoverable — the
    // developer copies the file and is then told about something they never
    // saw. Only AUTH_SECRET is blank, because it has to be generated rather
    // than copied.
    const result = validateEnv({ ...template });

    expect(result.success).toBe(false);
    if (result.success) return;

    const missing = new Set(result.error.issues.map((i) => String(i.path[0])));
    expect(missing).toEqual(new Set(['AUTH_SECRET']));
  });

  it('ships DATABASE_URL as a visibly fake placeholder, not a blank', () => {
    // It validates — it is a well-formed connection string — so fail-fast will
    // NOT catch it. That makes it important the placeholder is obvious on
    // sight, or the developer discovers it as a Postgres auth error instead.
    expect(template.DATABASE_URL).toMatch(/CHANGE_ME/);
    expect(validateEnv({ ...template, AUTH_SECRET: 'a'.repeat(44) }).success).toBe(true);
  });
});
