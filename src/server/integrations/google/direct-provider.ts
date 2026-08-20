/**
 * GoogleDirectProvider — GbpProvider implemented against Google's own APIs.
 *
 * Requires an approved Business Profile API access request. Until that lands,
 * quota is 0 QPM and every call returns a permission error; the platform
 * surfaces that as a clear "API access not yet approved" state rather than a
 * generic failure.
 */

import { GbpProvider, GbpProviderContext } from '@/server/integrations/google/provider';
import { googleRequest, paginate, GOOGLE_API_HOSTS } from '@/server/integrations/google/client';
import {
  LOCATION_READ_MASK,
  type GbpAccountResource,
  type GbpListAccountsResponse,
  type GbpListLocationsResponse,
  type GbpLocationResource,
} from '@/server/integrations/google/types';

const PAGE_SIZE = 100;

export class GoogleDirectProvider implements GbpProvider {
  readonly id = 'google-direct';

  async listAccounts(ctx: GbpProviderContext): Promise<GbpAccountResource[]> {
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
    return googleRequest<GbpLocationResource>(
      `${GOOGLE_API_HOSTS.businessInformation}/v1/${locationName}`,
      {
        accessToken: ctx.accessToken,
        query: { readMask: LOCATION_READ_MASK },
        logContext: { ...ctx.logContext, op: 'getLocation', locationName },
      },
    );
  }
}

/**
 * The provider in use.
 *
 * A vendor-backed implementation (Path B) would be selected here behind an env
 * flag without any service-layer change.
 */
export function getGbpProvider(): GbpProvider {
  return new GoogleDirectProvider();
}
