/**
 * Signed state for the Google Business Profile OAuth flow.
 *
 * The `state` parameter carries who started the flow and where to return them,
 * signed with HMAC-SHA256 so it cannot be forged. It is signed, NOT encrypted —
 * so it must never carry a secret. In particular the PKCE code verifier lives
 * in an httpOnly cookie, never in `state`, because `state` travels through the
 * browser address bar, referrer headers and server logs.
 *
 * Together the two halves defeat different attacks:
 *   - signed state + cookie nonce  -> CSRF (a forged callback)
 *   - PKCE verifier in a cookie    -> authorization code interception
 */

import { createHmac, randomBytes } from 'node:crypto';
import { env } from '@/config/env.server';
import { safeEquals } from '@/server/crypto/tokens';
import { BadRequestError } from '@/server/errors';

const STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStatePayload {
  /** Matched against an httpOnly cookie on callback to prevent CSRF. */
  nonce: string;
  organizationId: string;
  userId: string;
  /** Relative path to return to. Validated as relative on the way out. */
  returnTo: string;
  expiresAt: number;
}

function sign(payload: string): string {
  return createHmac('sha256', env.AUTH_SECRET).update(payload).digest('base64url');
}

export function createNonce(): string {
  return randomBytes(24).toString('base64url');
}

export function encodeState(payload: Omit<OAuthStatePayload, 'expiresAt'>): string {
  const full: OAuthStatePayload = { ...payload, expiresAt: Date.now() + STATE_TTL_MS };
  const body = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

/**
 * Verifies and decodes state. Throws on a bad signature, expiry, or a
 * `returnTo` that is not a relative path.
 */
export function decodeState(state: string, expectedNonce: string): OAuthStatePayload {
  const parts = state.split('.');
  if (parts.length !== 2) {
    throw new BadRequestError('Malformed OAuth state.');
  }

  const [body, signature] = parts;
  if (!safeEquals(signature, sign(body))) {
    throw new BadRequestError('OAuth state signature is invalid.');
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload;
  } catch {
    throw new BadRequestError('Unreadable OAuth state.');
  }

  if (typeof payload.expiresAt !== 'number' || payload.expiresAt < Date.now()) {
    throw new BadRequestError('This authorization link has expired. Start the connection again.');
  }

  // The nonce cookie proves the flow started in THIS browser session. A valid
  // signature alone does not — an attacker could replay a state they captured.
  if (!payload.nonce || !safeEquals(payload.nonce, expectedNonce)) {
    throw new BadRequestError('OAuth state does not match this session.');
  }

  // An open redirect here would let an attacker bounce a user off our domain.
  if (!payload.returnTo.startsWith('/') || payload.returnTo.startsWith('//')) {
    throw new BadRequestError('Invalid return path in OAuth state.');
  }

  return payload;
}

export const OAUTH_NONCE_COOKIE = 'gbp_oauth_nonce';
export const OAUTH_VERIFIER_COOKIE = 'gbp_oauth_verifier';

/** Cookie options for the two short-lived OAuth cookies. */
export function oauthCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    // Google redirects back with a top-level GET, which `lax` permits.
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: STATE_TTL_MS / 1000,
  };
}
