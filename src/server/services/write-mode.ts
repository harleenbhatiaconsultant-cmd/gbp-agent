/**
 * Explains the current write mode to the UI.
 *
 * Lives in the service layer so pages can display it without importing server
 * config, and phrased so an operator can tell at a glance whether this process
 * is capable of touching a real business listing.
 */

import { getWriteMode, isDryRun } from '@/config/features';

export interface WriteModeSummary {
  mode: string;
  /** True when executing an approved change performs a real mutation. */
  willApply: boolean;
  explanation: string;
}

export function getWriteModeSummary(): WriteModeSummary {
  const mode = getWriteMode();
  const dryRun = isDryRun();

  return {
    mode,
    willApply: !dryRun,
    explanation: dryRun
      ? 'Changes are sent to Google for validation only and nothing is modified. Google provides no ' +
        'sandbox, so this is the safe rehearsal. Approving a change queues it; applying it for real ' +
        'requires switching GBP_WRITE_MODE to "live" in a production environment.'
      : 'Live writes are enabled. Applying an approved change modifies the real business profile. ' +
        'Every change is still dry-run against Google first, and every applied change is recorded ' +
        'in the change log.',
  };
}
