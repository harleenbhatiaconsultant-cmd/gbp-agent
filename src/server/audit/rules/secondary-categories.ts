import { ActionType, AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, type RuleDefinition } from '@/server/audit/types';

const RECOMMENDED_MIN = 1;
const RECOMMENDED_MAX = 9;

/**
 * Secondary categories broaden the queries a profile can surface for, but each
 * one dilutes relevance. A small, genuinely-applicable set is the goal — this
 * rule flags both extremes rather than pushing for "more".
 */
export const secondaryCategoriesRule: RuleDefinition = {
  id: 'gbp.category.secondary_count',
  category: 'categories',
  scope: AuditScope.GBP,
  title: 'Secondary categories are used, but not overused',
  weight: 8,
  requires: ['profile'],

  evaluate(ctx) {
    const additional = ctx.profile.categories?.additionalCategories ?? [];
    const count = additional.length;

    if (count >= RECOMMENDED_MIN && count <= RECOMMENDED_MAX) return pass();

    if (count === 0) {
      return fail({
        severity: FindingSeverity.MEDIUM,
        title: 'No secondary categories are set',
        detail:
          'Secondary categories let the profile surface for related searches beyond the primary category. ' +
          'Add only categories that genuinely describe services the business offers — irrelevant ones dilute relevance rather than adding reach.',
        evidence: { secondaryCategoryCount: 0 },
        autoFixable: true,
        suggestedActionType: ActionType.UPDATE_CATEGORIES,
      });
    }

    return fail({
      severity: FindingSeverity.LOW,
      title: `${count} secondary categories may be diluting relevance`,
      detail:
        `This profile has ${count} secondary categories. Beyond roughly ${RECOMMENDED_MAX}, additional categories tend to weaken ` +
        'the profile’s relevance signal rather than strengthen it. Remove any that do not describe a service the business actually provides.',
      evidence: {
        secondaryCategoryCount: count,
        categories: additional.map((c) => c.displayName ?? c.name),
      },
      autoFixable: true,
      suggestedActionType: ActionType.UPDATE_CATEGORIES,
    });
  },
};
