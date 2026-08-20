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

  /** Set to make the next updateLocation reject, simulating a Google refusal. */
  failNextUpdateWith: Error | null = null;

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
    this.failNextUpdateWith = null;
  }
}
