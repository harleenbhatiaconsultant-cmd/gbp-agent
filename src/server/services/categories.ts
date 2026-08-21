/**
 * Category search.
 *
 * Backs the category editor. Categories are the single strongest ranking signal
 * a profile has, and Google rejects any id outside its own taxonomy — so this
 * has to search Google rather than let someone type `gcid:` and hope.
 *
 * The taxonomy is behind the same API access as everything else, which is not
 * yet approved. Rather than the editor simply breaking, the search reports WHY
 * it is unavailable so the UI can say so and fall back to entering a known id
 * by hand. That fallback exists because a blocked editor helps nobody, not
 * because typing category ids is a good idea.
 */

import { requireCapability } from '@/server/auth/rbac';
import type { TenantContext } from '@/server/auth/tenant-context';
import { NotFoundError } from '@/server/errors';
import { getGbpProvider } from '@/server/integrations/google/direct-provider';
import { isGbpError } from '@/server/integrations/google/errors';
import { getAccessToken } from '@/server/services/connections';
import { isGoogleConnectConfigured } from '@/server/services/connect-status';
import { childLogger } from '@/server/observability/logger';

export interface CategoryOption {
  id: string;
  displayName: string;
}

export type CategorySearchResult =
  | { available: true; categories: CategoryOption[] }
  | { available: false; reason: string };

/** Region is taken from the location's own address — the taxonomy differs by country. */
function regionCodeFor(address: unknown): string {
  if (address && typeof address === 'object') {
    const region = (address as { regionCode?: string }).regionCode;
    if (typeof region === 'string' && region.length === 2) return region.toUpperCase();
  }
  return 'US';
}

export async function searchCategories(
  ctx: TenantContext,
  locationId: string,
  query: string,
): Promise<CategorySearchResult> {
  requireCapability(ctx, 'location:view');

  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return { available: true, categories: [] };
  }

  if (!isGoogleConnectConfigured()) {
    return {
      available: false,
      reason:
        'Google OAuth is not configured, so the category list cannot be searched. Enter a known ' +
        'category id instead, or configure the connection first.',
    };
  }

  const location = await ctx.db.location.findFirst({
    where: { id: locationId },
    select: {
      address: true,
      gbpAccount: { select: { connectionId: true } },
    },
  });
  if (!location) throw new NotFoundError('Location not found.');

  const log = childLogger({ organizationId: ctx.organizationId, locationId });

  try {
    const accessToken = await getAccessToken(
      ctx.organizationId,
      location.gbpAccount.connectionId,
    );

    const categories = await getGbpProvider().searchCategories(
      {
        accessToken,
        connectionId: location.gbpAccount.connectionId,
        logContext: { organizationId: ctx.organizationId, locationId },
      },
      { query: trimmed, regionCode: regionCodeFor(location.address), limit: 20 },
    );

    return {
      available: true,
      categories: categories
        .filter((category) => Boolean(category.name))
        .map((category) => ({
          id: category.name,
          displayName: category.displayName ?? category.name,
        })),
    };
  } catch (error) {
    log.warn({ err: error }, 'Category search unavailable');

    // Distinguish "not approved yet" from a genuine fault — the first is the
    // expected state right now and should not read like something is broken.
    if (isGbpError(error)) {
      if (error.kind === 'permission' || error.kind === 'quota') {
        return {
          available: false,
          reason:
            'Google Business Profile API access has not been approved for this project yet, so ' +
            'the category list cannot be searched. Enter a known category id instead.',
        };
      }
      if (error.kind === 'auth') {
        return {
          available: false,
          reason: 'The Google connection needs to be reauthorized before categories can be searched.',
        };
      }
    }

    return {
      available: false,
      reason: 'The category list could not be reached. Enter a known category id instead.',
    };
  }
}
