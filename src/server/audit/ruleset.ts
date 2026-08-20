/**
 * Ruleset v1.
 *
 * The registry of every check the audit runs. `RULESET_VERSION` is recorded on
 * every AuditRun, so a score that changes between runs is always attributable
 * to either the profile or a deliberate ruleset change — never to ambiguity.
 *
 * Adding or reweighting a rule is a versioned change: bump RULESET_VERSION in
 * types.ts so historical scores stay interpretable.
 */

import type { RuleDefinition } from '@/server/audit/types';

import { primaryCategoryRule } from '@/server/audit/rules/primary-category';
import { secondaryCategoriesRule } from '@/server/audit/rules/secondary-categories';
import { locationPresenceRule } from '@/server/audit/rules/location-presence';
import { openStatusRule } from '@/server/audit/rules/open-status';
import { googleUpdatedRule } from '@/server/audit/rules/google-updated';
import { pendingEditsRule } from '@/server/audit/rules/pending-edits';
import { phoneNumberRule } from '@/server/audit/rules/phone-number';
import { websiteLinkRule } from '@/server/audit/rules/website-link';
import { regularHoursRule } from '@/server/audit/rules/regular-hours';
import { specialHoursRule } from '@/server/audit/rules/special-hours';
import { businessDescriptionRule } from '@/server/audit/rules/business-description';
import { serviceItemsRule } from '@/server/audit/rules/service-items';
import { reviewVolumeRule } from '@/server/audit/rules/review-volume';
import { reviewResponseRateRule } from '@/server/audit/rules/review-response-rate';
import { reviewVelocityRule } from '@/server/audit/rules/review-velocity';

export const RULESET: readonly RuleDefinition[] = [
  // Profile fundamentals — the checks that make everything else moot if failed.
  openStatusRule,
  locationPresenceRule,
  primaryCategoryRule,
  googleUpdatedRule,
  pendingEditsRule,

  // Contact and conversion paths.
  phoneNumberRule,
  websiteLinkRule,

  // Availability.
  regularHoursRule,
  specialHoursRule,

  // Content and reach.
  secondaryCategoriesRule,
  businessDescriptionRule,
  serviceItemsRule,

  // Reputation. These skip until the reviews sync exists.
  reviewVolumeRule,
  reviewResponseRateRule,
  reviewVelocityRule,
];

/** Guards against a duplicate rule id silently shadowing another's findings. */
export function assertRulesetIsValid(rules: readonly RuleDefinition[] = RULESET): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw new Error(`Duplicate audit rule id: ${rule.id}`);
    }
    seen.add(rule.id);
    if (rule.weight <= 0) {
      throw new Error(`Audit rule ${rule.id} must have a positive weight.`);
    }
  }
}
