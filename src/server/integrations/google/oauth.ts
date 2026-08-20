/**
 * Google OAuth 2.0 for Business Profile management.
 *
 * SEPARATE from platform sign-in (src/server/auth). This flow requests the
 * `business.manage` scope with offline access, producing a refresh token that
 * can modify a customer's listing. Signing in must never grant it implicitly.
 *
 * Uses google-auth-library for the token endpoints rather than hand-rolling
 * them — PKCE, clock skew and refresh semantics are easy to get subtly wrong.
 */

import { OAuth2Client } from 'google-auth-library';
import { requireGoogleOAuthCredentials } from '@/config/env.server';
import { GbpAuthError, GbpTransientError } from '@/server/integrations/google/errors';

export interface GoogleTokenSet {
  accessToken: string;
  /** Present only on the first authorization, or when consent is re-prompted. */
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

export function createOAuthClient(): OAuth2Client {
  const { clientId, clientSecret, redirectUri } = requireGoogleOAuthCredentials();
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

export interface AuthUrlResult {
  url: string;
  codeVerifier: string;
}

/**
 * Builds the consent URL.
 *
 * `prompt: 'consent'` is required, not cosmetic: Google returns a refresh token
 * only on the first authorization unless consent is re-requested. Without it a
 * reconnect would yield an access token with no way to refresh it.
 */
export async function buildAuthorizationUrl(state: string): Promise<AuthUrlResult> {
  const client = createOAuthClient();
  const { scopes } = requireGoogleOAuthCredentials();

  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state,
    code_challenge_method: 'S256' as never,
    code_challenge: codeChallenge,
    include_granted_scopes: true,
  });

  return { url, codeVerifier };
}

/** Exchanges an authorization code for tokens. */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<GoogleTokenSet> {
  const client = createOAuthClient();

  try {
    const { tokens } = await client.getToken({ code, codeVerifier });

    if (!tokens.access_token) {
      throw new GbpAuthError('Google did not return an access token.');
    }

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scopes: tokens.scope ? tokens.scope.split(' ') : [],
    };
  } catch (error) {
    if (error instanceof GbpAuthError) throw error;
    throw new GbpAuthError('Failed to exchange the authorization code with Google.', {
      cause: error,
    });
  }
}

/** Exchanges a refresh token for a fresh access token. */
export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenSet> {
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });

  try {
    const { credentials } = await client.refreshAccessToken();

    if (!credentials.access_token) {
      throw new GbpAuthError('Google did not return an access token on refresh.');
    }

    return {
      accessToken: credentials.access_token,
      // Google usually omits the refresh token on refresh; the stored one stays valid.
      refreshToken: credentials.refresh_token ?? null,
      expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
      scopes: credentials.scope ? credentials.scope.split(' ') : [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // `invalid_grant` means the user revoked access or changed their password.
    // It is permanent: the connection needs re-consent, not a retry.
    if (message.includes('invalid_grant')) {
      throw new GbpAuthError(
        'The Google authorization was revoked or has expired. Reconnect the account.',
        { cause: error, googleReason: 'invalid_grant' },
      );
    }

    throw new GbpTransientError('Failed to refresh the Google access token.', { cause: error });
  }
}

/**
 * Revokes a token at Google.
 *
 * Best-effort: an already-invalid token reports an error, which is the desired
 * end state anyway. The caller deletes local credentials regardless.
 */
export async function revokeToken(token: string): Promise<{ revoked: boolean }> {
  try {
    const client = createOAuthClient();
    await client.revokeToken(token);
    return { revoked: true };
  } catch {
    return { revoked: false };
  }
}

/** Reads the signed-in Google account's email, to label the connection. */
export async function fetchGoogleAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { email?: string };
    return body.email ?? null;
  } catch {
    return null;
  }
}
