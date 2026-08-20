import { ActionType, AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, type RuleDefinition } from '@/server/audit/types';

/**
 * The primary category is the single strongest GBP ranking signal, and a wrong
 * one is the single most damaging profile error. Absence is critical.
 *
 * This rule deliberately does NOT judge whether the chosen category is the
 * "best" one — that requires knowing the business, and a wrong automated guess
 * is worse than no guess. Category changes always require human approval.
 */
export const primaryCategoryRule: RuleDefinition = {
  id: 'gbp.category.primary_missing',
  category: 'categories',
  scope: AuditScope.GBP,
  title: 'Primary category is set',
  weight: 20,
  requires: ['profile'],

  evaluate(ctx) {
    const primary = ctx.profile.categories?.primaryCategory;

    if (primary?.name) return pass();

    return fail({
      severity: FindingSeverity.CRITICAL,
      title: 'No primary category is set',
      detail:
        'The primary category is the strongest single ranking factor for the local pack. ' +
        'Without one, Google has no reliable signal for which searches this business should appear in. ' +
        'Choose the most specific category that describes the main service.',
      evidence: { primaryCategory: null },
      autoFixable: true,
      suggestedActionType: ActionType.UPDATE_CATEGORIES,
    });
  },
};
