/**
 * Orchestrates the Google Business Profile connect flow.
 *
 * Route handlers own HTTP concerns (cookies, redirects) and nothing else; the
 * security-relevant sequencing lives here:
 *
 *   start    -> build signed state + PKCE verifier, hand both back for cookies
 *   complete -> verify state against the cookie nonce, exchange the code using
 *               the verifier, then store the sealed refresh token
 */

import { prisma } from '@/server/db';
import { requireCapability } from '@/server/auth/rbac';
import type { TenantContext } from '@/server/auth/tenant-context';
import { BadRequestError, ForbiddenError, NotFoundError } from '@/server/errors';
import {
  createNonce,
  encodeState,
  decodeState,
} from '@/server/crypto/oauth-state';
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchGoogleAccountEmail,
} from '@/server/integrations/google/oauth';
import { upsertConnection } from '@/server/services/connections';
import { childLogger } from '@/server/observability/logger';
import { isGbpError } from '@/server/integrations/google/errors';

export interface StartConnectResult {
  authorizationUrl: string;
  nonce: string;
  codeVerifier: string;
}

export async function startConnectFlow(
  ctx: TenantContext,
  returnTo: string,
): Promise<StartConnectResult> {
  requireCapability(ctx, 'connection:manage');

  if (!ctx.userId) {
    throw new ForbiddenError('Connecting a Google account requires a signed-in user.');
  }

  const nonce = createNonce();
  const state = encodeState({
    nonce,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    returnTo,
  });

  const { url, codeVerifier } = await buildAuthorizationUrl(state);

  return { authorizationUrl: url, nonce, codeVerifier };
}

export interface CompleteConnectInput {
  code: string;
  state: string;
  /** From the httpOnly cookie set at the start of the flow. */
  nonce: string | undefined;
  codeVerifier: string | undefined;
  /** The currently signed-in user, to confirm the flow was not handed off. */
  currentUserId: string;
}

export interface CompleteConnectResult {
  connectionId: string;
  organizationSlug: string;
  googleAccountEmail: string;
  returnTo: string;
}

export async function completeConnectFlow(
  input: CompleteConnectInput,
): Promise<CompleteConnectResult> {
  if (!input.nonce || !input.codeVerifier) {
    // Cookies missing means the callback did not follow a start in this browser.
    throw new BadRequestError(
      'This authorization did not start in this browser, or it has expired. Start the connection again.',
    );
  }

  // Verifies signature, expiry, nonce match, and that returnTo is relative.
  const state = decodeState(input.state, input.nonce);

  if (state.userId !== input.currentUserId) {
    throw new ForbiddenError('This authorization was started by a different user.');
  }

  // Re-check membership at completion: it may have been revoked mid-flow.
  const membership = await prisma.membership.findUnique({
    where: {
      userId_organizationId: {
        userId: input.currentUserId,
        organizationId: state.organizationId,
      },
    },
    include: { organization: { select: { slug: true } } },
  });
  if (!membership) throw new NotFoundError('Organization not found.');

  const log = childLogger({
    organizationId: state.organizationId,
    userId: input.currentUserId,
  });

  // Google-shaped errors are translated here so callers above the service layer
  // deal in AppError only, and never need to import the integration package.
  let tokens;
  try {
    tokens = await exchangeCodeForTokens(input.code, input.codeVerifier);
  } catch (error) {
    if (isGbpError(error)) {
      log.error({ err: error, kind: error.kind }, 'Token exchange with Google failed');
      throw new BadRequestError(
        'Google rejected the authorization. Start the connection again.',
        { googleReason: error.googleReason },
      );
    }
    throw error;
  }

  const googleAccountEmail =
    (await fetchGoogleAccountEmail(tokens.accessToken)) ?? 'unknown@google';

  const { id: connectionId } = await upsertConnection({
    organizationId: state.organizationId,
    userId: input.currentUserId,
    googleAccountEmail,
    tokens,
  });

  log.info({ connectionId, googleAccountEmail }, 'Google Business Profile connected');

  return {
    connectionId,
    organizationSlug: membership.organization.slug,
    googleAccountEmail,
    returnTo: state.returnTo,
  };
}
