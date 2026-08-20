import { ActionType, AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, type RuleDefinition } from '@/server/audit/types';

/**
 * Special hours override regular hours on holidays. Google actively prompts
 * searchers with "hours might differ" when they are unset, which undermines
 * confidence in the listing.
 *
 * Only future-dated entries count: last year's holiday hours are not coverage.
 */
export const specialHoursRule: RuleDefinition = {
  id: 'gbp.hours.special_missing',
  category: 'hours',
  scope: AuditScope.GBP,
  title: 'Upcoming holiday hours are set',
  weight: 5,
  requires: ['profile'],

  evaluate(ctx) {
    if (ctx.profile.openInfo?.status === 'CLOSED_PERMANENTLY') return pass();

    const periods = ctx.profile.specialHours?.specialHourPeriods ?? [];

    const upcoming = periods.filter((period) => {
      const date = period.startDate;
      if (!date?.year || !date.month || !date.day) return false;
      return new Date(date.year, date.month - 1, date.day) >= ctx.evaluatedAt;
    });

    if (upcoming.length > 0) return pass();

    return fail({
      severity: FindingSeverity.LOW,
      title: 'No upcoming holiday hours are set',
      detail:
        'When holiday hours are unset, Google shows searchers a "hours might differ" warning on the listing. ' +
        'Setting them ahead of public holidays removes that warning and prevents wasted trips.',
      evidence: { totalSpecialPeriods: periods.length, upcomingPeriods: 0 },
      autoFixable: true,
      suggestedActionType: ActionType.UPDATE_SPECIAL_HOURS,
    });
  },
};
