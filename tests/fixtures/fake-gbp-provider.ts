/**
 * Recording test double for the Google Business Profile provider.
 *
 * Google offers no sandbox, so the only way to assert what the platform WOULD
 * send is to intercept it. Every call is recorded, including the `validateOnly`
 * flag — which is what lets the tests prove that a live write never leaves the
 * process under the default configuration.
 *
 * Installed via `setGbpProviderForTesting`, which refuses to run in production.
 */

import type {
  GbpProvider,
  GbpProviderContext,
  GbpWriteProvider,
} from '@/server/integrations/google/provider';
import type {
  GbpAccountResource,
  GbpCategoryResource,
  GbpLocationResource,
} from '@/server/integrations/google/types';

export interface RecordedUpdate {
  locationName: string;
  patch: Partial<GbpLocationResource>;
  updateMask: string[];
  validateOnly: boolean;
}

export class FakeGbpProvider implements GbpProvider, GbpWriteProvider {
  readonly id = 'fake';

  readonly updates: RecordedUpdate[] = [];
  readonly reads: string[] = [];
  readonly categorySearches: string[] = [];

  /** Stand-in taxonomy for category-editor tests. */
  categories: GbpCategoryResource[] = [
    { name: 'gcid:dentist', displayName: 'Dentist' },
    { name: 'gcid:dental_clinic', displayName: 'Dental clinic' },
    { name: 'gcid:cosmetic_dentist', displayName: 'Cosmetic dentist' },
    { name: 'gcid:orthodontist', displayName: 'Orthodontist' },
    { name: 'gcid:plumber', displayName: 'Plumber' },
  ];

  /** Set to make the next updateLocation reject, simulating a Google refusal. */
  failNextUpdateWith: Error | null = null;

  /** Set to make the next searchCategories reject. */
  failNextSearchWith: Error | null = null;

  constructor(
    private profile: GbpLocationResource,
    private accounts: GbpAccountResource[] = [],
  ) {}

  /** Calls that would have mutated a real profile. Must stay empty by default. */
  get liveWrites(): RecordedUpdate[] {
    return this.updates.filter((u) => !u.validateOnly);
  }

  get dryRuns(): RecordedUpdate[] {
    return this.updates.filter((u) => u.validateOnly);
  }

  setProfile(profile: GbpLocationResource): void {
    this.profile = profile;
  }

  async listAccounts(): Promise<GbpAccountResource[]> {
    return this.accounts;
  }

  async listLocations(): Promise<GbpLocationResource[]> {
    return [this.profile];
  }

  /** Substring match over `categories`, standing in for Google's taxonomy. */
  async searchCategories(
    _ctx: GbpProviderContext,
    params: { query: string },
  ): Promise<GbpCategoryResource[]> {
    if (this.failNextSearchWith) {
      const error = this.failNextSearchWith;
      this.failNextSearchWith = null;
      throw error;
    }

    this.categorySearches.push(params.query);
    const needle = params.query.toLowerCase();
    return this.categories.filter(
      (category) =>
        category.displayName?.toLowerCase().includes(needle) ||
        category.name.toLowerCase().includes(needle),
    );
  }

  async getLocation(_ctx: GbpProviderContext, locationName: string): Promise<GbpLocationResource> {
    this.reads.push(locationName);
    return this.profile;
  }

  async updateLocation(
    _ctx: GbpProviderContext,
    locationName: string,
    patch: Partial<GbpLocationResource>,
    updateMask: string[],
    options: { validateOnly: boolean },
  ): Promise<GbpLocationResource> {
    this.updates.push({
      locationName,
      patch,
      updateMask,
      validateOnly: options.validateOnly,
    });

    if (this.failNextUpdateWith) {
      const error = this.failNextUpdateWith;
      this.failNextUpdateWith = null;
      throw error;
    }

    // A real live write returns the updated resource; a dry run returns the
    // request echoed back. Merging the patch approximates both closely enough
    // for assertions about beforeState/afterState.
    if (!options.validateOnly) {
      this.profile = { ...this.profile, ...patch };
    }
    return this.profile;
  }

  reset(): void {
    this.updates.length = 0;
    this.reads.length = 0;
    this.categorySearches.length = 0;
    this.failNextUpdateWith = null;
    this.failNextSearchWith = null;
  }
}
