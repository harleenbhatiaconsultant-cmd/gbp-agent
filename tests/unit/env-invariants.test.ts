/**
 * Environment invariants.
 *
 * These are the cross-field checks that run at boot. Testing them directly —
 * rather than by importing the env module under a contrived environment — means
 * each one can be exercised in isolation, including the production cases that
 * cannot otherwise be reached from a test run.
 */

import { describe, it, expect } from 'vitest';
import { assertEnvironmentInvariants, env, type ServerEnv } from '@/config/env.server';

/** The real parsed env, overridden per case. */
function envWith(overrides: Partial<ServerEnv>): ServerEnv {
  return { ...env, ...overrides } as ServerEnv;
}

const productionUrls = {
  APP_URL: 'https://app.example.com',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
  AUTH_URL: 'https://app.example.com',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://app.example.com/api/google/oauth/callback',
} as const;

describe('write-mode invariant', () => {
  it('refuses live writes outside production', () => {
    expect(() =>
      assertEnvironmentInvariants(envWith({ GBP_WRITE_MODE: 'live', NODE_ENV: 'development' })),
    ).toThrowError(/only permitted when NODE_ENV=production/);
  });

  it('permits live writes in production', () => {
    expect(() =>
      assertEnvironmentInvariants(
        envWith({ GBP_WRITE_MODE: 'live', NODE_ENV: 'production', ...productionUrls }),
      ),
    ).not.toThrow();
  });
});

describe('auto-apply invariant', () => {
  it('refuses auto-apply outside production', () => {
    expect(() =>
      assertEnvironmentInvariants(envWith({ ENABLE_AUTO_APPLY: true, NODE_ENV: 'test' })),
    ).toThrowError(/ENABLE_AUTO_APPLY=true is only permitted/);
  });
});

describe('localhost defaults in production', () => {
  it('refuses a localhost OAuth redirect URI', () => {
    // Left unset in production this would produce redirect_uri_mismatch at the
    // END of a user's sign-in, which is a miserable place to discover it.
    expect(() =>
      assertEnvironmentInvariants(
        envWith({
          NODE_ENV: 'production',
          ...productionUrls,
          GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3000/api/google/oauth/callback',
        }),
      ),
    ).toThrowError(/GOOGLE_OAUTH_REDIRECT_URI/);
  });

  it('refuses a localhost APP_URL', () => {
    expect(() =>
      assertEnvironmentInvariants(
        envWith({ NODE_ENV: 'production', ...productionUrls, APP_URL: 'http://localhost:3000' }),
      ),
    ).toThrowError(/APP_URL/);
  });

  it('names every offender at once rather than one per restart', () => {
    try {
      assertEnvironmentInvariants(envWith({ NODE_ENV: 'production' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      // Fixing these one boot-failure at a time would be four deploys.
      for (const key of [
        'APP_URL',
        'NEXT_PUBLIC_APP_URL',
        'AUTH_URL',
        'GOOGLE_OAUTH_REDIRECT_URI',
      ]) {
        expect(message).toContain(key);
      }
    }
  });

  it.each(['127.0.0.1', '::1', '0.0.0.0'])('also catches %s, not just the word localhost', (host) => {
    const url = host === '::1' ? `http://[${host}]:3000` : `http://${host}:3000`;
    expect(() =>
      assertEnvironmentInvariants(
        envWith({ NODE_ENV: 'production', ...productionUrls, APP_URL: url }),
      ),
    ).toThrowError(/APP_URL/);
  });

  it('accepts real URLs in production', () => {
    expect(() =>
      assertEnvironmentInvariants(envWith({ NODE_ENV: 'production', ...productionUrls })),
    ).not.toThrow();
  });

  it('leaves development alone — the defaults are the point there', () => {
    // A fresh clone must run without ceremony; that is what the defaults are for.
    expect(() => assertEnvironmentInvariants(envWith({ NODE_ENV: 'development' }))).not.toThrow();
  });

  it('is skipped during next build, which runs as production but is not the server', () => {
    // `next build` sets NODE_ENV=production and imports server modules to
    // collect page data. A developer building locally has localhost in .env
    // legitimately, and deploy pipelines build before real env vars are
    // attached — so enforcing this at build time fails every such build.
    // The first version of this check did exactly that.
    const previous = process.env.NEXT_PHASE;
    process.env.NEXT_PHASE = 'phase-production-build';
    try {
      expect(() =>
        assertEnvironmentInvariants(envWith({ NODE_ENV: 'production' })),
      ).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.NEXT_PHASE;
      else process.env.NEXT_PHASE = previous;
    }
  });

  it('still enforces at runtime, when NEXT_PHASE is not the build phase', () => {
    const previous = process.env.NEXT_PHASE;
    delete process.env.NEXT_PHASE;
    try {
      expect(() =>
        assertEnvironmentInvariants(envWith({ NODE_ENV: 'production' })),
      ).toThrowError(/point at localhost/);
    } finally {
      if (previous !== undefined) process.env.NEXT_PHASE = previous;
    }
  });

  it('does not flag a hostname that merely contains "localhost"', () => {
    expect(() =>
      assertEnvironmentInvariants(
        envWith({
          NODE_ENV: 'production',
          ...productionUrls,
          APP_URL: 'https://localhost.example.com',
        }),
      ),
    ).not.toThrow();
  });
});
