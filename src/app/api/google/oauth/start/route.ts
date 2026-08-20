/**
 * Begins the Google Business Profile connect flow.
 *
 * Thin by design: it resolves the tenant, asks the service for an authorization
 * URL, plants the two short-lived httpOnly cookies, and redirects. The nonce and
 * PKCE verifier are set as cookies rather than passed through the URL, because
 * `state` is signed but not encrypted and travels through address bars and logs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@/server/auth/session';
import { startConnectFlow } from '@/server/services/connect-flow';
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  oauthCookieOptions,
} from '@/server/crypto/oauth-state';
import { toClientError } from '@/server/errors';
import { logger } from '@/server/observability/logger';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const orgSlug = request.nextUrl.searchParams.get('org');
  if (!orgSlug) {
    return NextResponse.json(
      { error: 'Missing required "org" parameter.' },
      { status: 400 },
    );
  }

  try {
    const ctx = await resolveTenantContext(orgSlug);
    const returnTo = `/${ctx.organizationSlug}/settings/connections`;

    const { authorizationUrl, nonce, codeVerifier } = await startConnectFlow(ctx, returnTo);

    const response = NextResponse.redirect(authorizationUrl);
    const options = oauthCookieOptions();
    response.cookies.set(OAUTH_NONCE_COOKIE, nonce, options);
    response.cookies.set(OAUTH_VERIFIER_COOKIE, codeVerifier, options);
    return response;
  } catch (error) {
    logger.error({ err: error, orgSlug }, 'Failed to start the Google connect flow');
    const clientError = toClientError(error);
    return NextResponse.json(
      { code: clientError.code, error: clientError.message },
      { status: clientError.httpStatus },
    );
  }
}
