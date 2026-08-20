import { AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, type RuleDefinition } from '@/server/audit/types';

/**
 * Google applies edits from its own sources and from user submissions. Those
 * edits are live and were never made by the owner — this is precisely the
 * silent drift that continuous monitoring exists to catch.
 *
 * Not auto-fixable: correcting it means deciding which version is right, which
 * requires knowing the business.
 */
export const googleUpdatedRule: RuleDefinition = {
  id: 'gbp.profile.google_updated',
  category: 'profile_completeness',
  scope: AuditScope.GBP,
  title: 'Google has not overridden profile data',
  weight: 8,
  requires: ['profile'],

  evaluate(ctx) {
    if (!ctx.profile.metadata?.hasGoogleUpdated) return pass();

    return fail({
      severity: FindingSeverity.HIGH,
      title: 'Google has applied its own updates to this profile',
      detail:
        'Google has changed profile data from its own sources or from user submissions. These edits are live ' +
        'now and were not made by the owner. Review them against the intended values — this is the most common ' +
        'cause of a profile drifting without anyone noticing.',
      evidence: { hasGoogleUpdated: true },
      autoFixable: false,
    });
  },
};
