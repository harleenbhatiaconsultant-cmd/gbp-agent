/**
 * GoogleDirectProvider — GbpProvider implemented against Google's own APIs.
 *
 * Requires an approved Business Profile API access request. Until that lands,
 * quota is 0 QPM and every call returns a permission error; the platform
 * surfaces that as a clear "API access not yet approved" state rather than a
 * generic failure.
 */

import {
  GbpProvider,
  GbpProviderContext,
  GbpWriteProvider,
} from '@/server/integrations/google/provider';
import { googleRequest, paginate, GOOGLE_API_HOSTS } from '@/server/integrations/google/client';
import { acquireRequestSlot, acquireEditSlot } from '@/server/integrations/google/quota';
import {
  LOCATION_READ_MASK,
  type GbpAccountResource,
  type GbpCategoryResource,
  type GbpListAccountsResponse,
  type GbpListCategoriesResponse,
  type GbpListLocationsResponse,
  type GbpLocationResource,
} from '@/server/integrations/google/types';

const PAGE_SIZE = 100;

export class GoogleDirectProvider implements GbpProvider, GbpWriteProvider {
  readonly id = 'google-direct';

  async listAccounts(ctx: GbpProviderContext): Promise<GbpAccountResource[]> {
    await acquireRequestSlot(ctx.connectionId ?? 'unknown');
    return paginate<GbpAccountResource, GbpListAccountsResponse>(
      (pageToken) =>
        googleRequest<GbpListAccountsResponse>(
          `${GOOGLE_API_HOSTS.accountManagement}/v1/accounts`,
          {
            accessToken: ctx.accessToken,
            query: { pageSize: PAGE_SIZE, pageToken },
            logContext: { ...ctx.logContext, op: 'listAccounts' },
          },
        ),
      (response) => response.accounts,
    );
  }

  async listLocations(
    ctx: GbpProviderContext,
    accountName: string,
  ): Promise<GbpLocationResource[]> {
    await acquireRequestSlot(ctx.connectionId ?? 'unknown');
    return paginate<GbpLocationResource, GbpListLocationsResponse>(
      (pageToken) =>
        googleRequest<GbpListLocationsResponse>(
          `${GOOGLE_API_HOSTS.businessInformation}/v1/${accountName}/locations`,
          {
            accessToken: ctx.accessToken,
            // readMask is mandatory on this API — omitting it is an error.
            query: { readMask: LOCATION_READ_MASK, pageSize: PAGE_SIZE, pageToken },
            logContext: { ...ctx.logContext, op: 'listLocations', accountName },
          },
        ),
      (response) => response.locations,
    );
  }

  async getLocation(
    ctx: GbpProviderContext,
    locationName: string,
  ): Promise<GbpLocationResource> {
    await acquireRequestSlot(ctx.connectionId ?? 'unknown');
    return googleRequest<GbpLocationResource>(
      `${GOOGLE_API_HOSTS.businessInformation}/v1/${locationName}`,
      {
        accessToken: ctx.accessToken,
        query: { readMask: LOCATION_READ_MASK },
        logContext: { ...ctx.logContext, op: 'getLocation', locationName },
      },
    );
  }

  /**
   * Searches Google's category taxonomy.
   *
   * `filter` uses Google's own syntax; `displayName=` performs a prefix/substring
   * match rather than an exact one, which is what makes it usable as a search
   * box. The result set is capped because this backs a type-ahead and nobody
   * scrolls past twenty categories.
   */
  async searchCategories(
    ctx: GbpProviderContext,
    params: { query: string; regionCode: string; languageCode?: string; limit?: number },
  ): Promise<GbpCategoryResource[]> {
    await acquireRequestSlot(ctx.connectionId ?? 'unknown');

    const response = await googleRequest<GbpListCategoriesResponse>(
      `${GOOGLE_API_HOSTS.businessInformation}/v1/categories`,
      {
        accessToken: ctx.accessToken,
        query: {
          regionCode: params.regionCode,
          languageCode: params.languageCode ?? 'en',
          view: 'BASIC',
          filter: `displayName=${params.query}`,
          pageSize: Math.min(params.limit ?? 20, 100),
        },
        logContext: { ...ctx.logContext, op: 'searchCategories', regionCode: params.regionCode },
      },
    );

    return response.categories ?? [];
  }

  /**
   * Patches a location.
   *
   * `validateOnly` is a required parameter rather than an option with a
   * default, so no call site can omit it and accidentally perform a live write.
   * When true, Google validates the request and changes nothing — the only
   * rehearsal available, since there is no sandbox.
   *
   * `updateMask` is mandatory and Google replaces ONLY the masked fields. A
   * mask wider than the patch erases data, so executors build the two together.
   */
  async updateLocation(
    ctx: GbpProviderContext,
    locationName: string,
    patch: Partial<GbpLocationResource>,
    updateMask: string[],
    options: { validateOnly: boolean },
  ): Promise<GbpLocationResource> {
    if (updateMask.length === 0) {
      throw new Error('Refusing to patch a location with an empty updateMask.');
    }

    // Writes consume BOTH budgets: the global request rate and the far tighter
    // per-profile edit rate. The edit slot is taken first because it is the one
    // that actually gets a profile throttled by Google.
    await acquireEditSlot(locationName);
    await acquireRequestSlot(ctx.connectionId ?? 'unknown');

    return googleRequest<GbpLocationResource>(
      `${GOOGLE_API_HOSTS.businessInformation}/v1/${locationName}`,
      {
        method: 'PATCH',
        accessToken: ctx.accessToken,
        query: {
          updateMask: updateMask.join(','),
          validateOnly: options.validateOnly,
        },
        body: patch,
        logContext: {
          ...ctx.logContext,
          op: 'updateLocation',
          locationName,
          updateMask,
          validateOnly: options.validateOnly,
        },
      },
    );
  }
}

/**
 * Test seam.
 *
 * Google has no sandbox, so executor and approval-pipeline tests run against a
 * recorded double installed here. Production never calls this — an override is
 * refused outside development and test.
 */
let providerOverride: (GbpProvider & GbpWriteProvider) | null = null;

export function setGbpProviderForTesting(
  provider: (GbpProvider & GbpWriteProvider) | null,
): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The GBP provider cannot be overridden in production.');
  }
  providerOverride = provider;
}

/**
 * The provider in use.
 *
 * A vendor-backed implementation (Path B) would be selected here behind an env
 * flag without any service-layer change.
 */
export function getGbpProvider(): GbpProvider & GbpWriteProvider {
  return providerOverride ?? new GoogleDirectProvider();
}
