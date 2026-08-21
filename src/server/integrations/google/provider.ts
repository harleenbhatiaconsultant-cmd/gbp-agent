/**
 * The GbpProvider interface.
 *
 * Every Google Business Profile capability the platform uses is expressed here.
 * Services depend on this interface, never on a concrete client, which is what
 * keeps the Path A / Path B decision (ARCHITECTURE.md §4.1) a swap rather than
 * a rewrite:
 *
 *   - GoogleDirectProvider  — Google's own APIs, requires approved API access.
 *   - a vendor provider     — a managed GBP API layer, same interface.
 *
 * Read methods are implemented now (Phases 2-3). Write methods are declared
 * here so the shape is settled, and land with the executor registry in the
 * write-capable phase. Nothing in this interface bypasses the approval pipeline:
 * a provider is called by an executor, and an executor runs only on an approved
 * ChangeRequest.
 */

import type {
  GbpAccountResource,
  GbpCategoryResource,
  GbpLocationResource,
} from '@/server/integrations/google/types';

export interface GbpProviderContext {
  /** Short-lived access token. Providers never see the refresh token. */
  accessToken: string;
  /**
   * The connection this call is made on behalf of. Used to key the request-rate
   * governor, so one customer's sync cannot exhaust another's budget.
   */
  connectionId?: string;
  /** Correlation fields for logging. Must not contain credentials. */
  logContext?: Record<string, unknown>;
}

export interface GbpProvider {
  readonly id: string;

  /** Accounts the authorized user can administer. */
  listAccounts(ctx: GbpProviderContext): Promise<GbpAccountResource[]>;

  /** Locations under one account. `accountName` is "accounts/123". */
  listLocations(ctx: GbpProviderContext, accountName: string): Promise<GbpLocationResource[]>;

  /** One location. `locationName` is "locations/456". */
  getLocation(ctx: GbpProviderContext, locationName: string): Promise<GbpLocationResource>;

  /**
   * Searches Google's category taxonomy.
   *
   * Categories are regional and localized, and Google rejects any id outside
   * its own list — so a category cannot be typed by hand with any confidence.
   * This is what backs the category editor.
   */
  searchCategories(
    ctx: GbpProviderContext,
    params: { query: string; regionCode: string; languageCode?: string; limit?: number },
  ): Promise<GbpCategoryResource[]>;
}

/**
 * Write surface, declared for shape only.
 *
 * `validateOnly` is not an optional convenience — Google provides no sandbox,
 * so it is the only way to rehearse a mutation. Implementations MUST honour it.
 */
export interface GbpWriteProvider {
  updateLocation(
    ctx: GbpProviderContext,
    locationName: string,
    patch: Partial<GbpLocationResource>,
    updateMask: string[],
    options: { validateOnly: boolean },
  ): Promise<GbpLocationResource>;
}
