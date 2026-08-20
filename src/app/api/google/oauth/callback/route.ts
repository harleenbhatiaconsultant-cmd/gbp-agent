/**
 * Google OAuth callback.
 *
 * Consumes the one-time cookies, delegates verification and token exchange to
 * the service, and always clears the cookies afterwards — on success and on
 * failure alike, so a stale verifier can never be replayed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/session';
import { completeConnectFlow } from '@/server/services/connect-flow';
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
} from '@/server/crypto/oauth-state';
import { isAppError } from '@/server/errors';
import { logger } from '@/server/observability/logger';

export const dynamic = 'force-dynamic';

function clearOAuthCookies(response: NextResponse): NextResponse {
  response.cookies.delete(OAUTH_NONCE_COOKIE);
  response.cookies.delete(OAUTH_VERIFIER_COOKIE);
  return response;
}

function failureRedirect(request: NextRequest, message: string): NextResponse {
  const url = new URL('/', request.nextUrl.origin);
  url.searchParams.set('connectError', message);
  return clearOAuthCookies(NextResponse.redirect(url));
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  // The user declined consent, or Google rejected the request.
  const googleError = params.get('error');
  if (googleError) {
    return failureRedirect(
      request,
      googleError === 'access_denied'
        ? 'Authorization was cancelled.'
        : 'Google rejected the authorization request.',
    );
  }

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) {
    return failureRedirect(request, 'Incomplete authorization response from Google.');
  }

  try {
    const user = await requireUser();

    const result = await completeConnectFlow({
      code,
      state,
      nonce: request.cookies.get(OAUTH_NONCE_COOKIE)?.value,
      codeVerifier: request.cookies.get(OAUTH_VERIFIER_COOKIE)?.value,
      currentUserId: user.id,
    });

    const url = new URL(result.returnTo, request.nextUrl.origin);
    url.searchParams.set('connected', result.googleAccountEmail);
    return clearOAuthCookies(NextResponse.redirect(url));
  } catch (error) {
    logger.error({ err: error }, 'Google OAuth callback failed');

    // The service translates Google-shaped failures into AppError, so only the
    // `expose` flag decides what the user is shown here.
    const message =
      isAppError(error) && error.expose
        ? error.message
        : 'Could not complete the Google connection.';

    return failureRedirect(request, message);
  }
}
