import { ActionType, AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, type RuleDefinition } from '@/server/audit/types';

/**
 * Hours are a direct ranking and conversion signal: Google surfaces "open now"
 * prominently, and a profile with no hours cannot participate in that.
 *
 * Businesses legitimately marked CLOSED_PERMANENTLY are exempt — flagging
 * missing hours on a closed business is noise, not a finding.
 */
export const regularHoursRule: RuleDefinition = {
  id: 'gbp.hours.regular_missing',
  category: 'hours',
  scope: AuditScope.GBP,
  title: 'Regular opening hours are set',
  weight: 15,
  requires: ['profile'],

  evaluate(ctx) {
    const status = ctx.profile.openInfo?.status;
    if (status === 'CLOSED_PERMANENTLY') {
      return pass();
    }

    const periods = ctx.profile.regularHours?.periods ?? [];

    if (periods.length === 0) {
      return fail({
        severity: FindingSeverity.HIGH,
        title: 'No opening hours are set',
        detail:
          'Google cannot show this business as "open now" without hours, and searchers filtering by ' +
          'availability will not see it. Hours are also a trust signal — a profile without them looks abandoned.',
        evidence: { periodCount: 0 },
        autoFixable: true,
        suggestedActionType: ActionType.UPDATE_REGULAR_HOURS,
      });
    }

    const daysCovered = new Set(periods.map((p) => p.openDay).filter(Boolean));

    if (daysCovered.size < 3) {
      return fail({
        severity: FindingSeverity.MEDIUM,
        title: 'Opening hours cover only part of the week',
        detail:
          `Hours are set for ${daysCovered.size} day(s). If the business is closed on the remaining days that is fine, ` +
          'but confirm the schedule is complete — partial hours are usually an incomplete entry rather than a deliberate one.',
        evidence: { daysCovered: [...daysCovered], periodCount: periods.length },
        autoFixable: true,
        suggestedActionType: ActionType.UPDATE_REGULAR_HOURS,
      });
    }

    return pass();
  },
};
