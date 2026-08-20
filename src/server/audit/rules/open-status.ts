import { AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, type RuleDefinition } from '@/server/audit/types';

/**
 * Surfaces states that make every other finding moot.
 *
 * Nothing here is auto-fixable: a suspension is resolved through Google's
 * reinstatement process, not an API write, and reopening a permanently closed
 * listing is a business decision.
 */
export const openStatusRule: RuleDefinition = {
  id: 'gbp.profile.open_status',
  category: 'profile_completeness',
  scope: AuditScope.GBP,
  title: 'Profile is open and in good standing',
  weight: 20,
  requires: ['profile'],

  evaluate(ctx) {
    const status = ctx.profile.openInfo?.status;

    if (status === 'CLOSED_PERMANENTLY') {
      return fail({
        severity: FindingSeverity.CRITICAL,
        title: 'Profile is marked permanently closed',
        detail:
          'A permanently closed listing is removed from local results. If the business is still trading this ' +
          'must be corrected immediately — it is the most damaging state a profile can be in.',
        evidence: { openStatus: status },
        autoFixable: false,
      });
    }

    if (status === 'CLOSED_TEMPORARILY') {
      return fail({
        severity: FindingSeverity.HIGH,
        title: 'Profile is marked temporarily closed',
        detail:
          'Temporarily closed listings are heavily suppressed in local results. If the business is trading ' +
          'again, clear this status — it does not expire on its own.',
        evidence: { openStatus: status },
        autoFixable: false,
      });
    }

    return pass();
  },
};
