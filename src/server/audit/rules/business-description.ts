import { ActionType, AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, type RuleDefinition } from '@/server/audit/types';

const GOOGLE_MAX_LENGTH = 750;
const THIN_THRESHOLD = 150;

/**
 * The description does not directly drive ranking, but it is prominent in the
 * profile and is what a searcher reads before choosing. Thin or absent text is
 * a conversion problem more than a ranking one.
 */
export const businessDescriptionRule: RuleDefinition = {
  id: 'gbp.content.description',
  category: 'content',
  scope: AuditScope.GBP,
  title: 'Business description is present and substantive',
  weight: 8,
  requires: ['profile'],

  evaluate(ctx) {
    const description = ctx.profile.profile?.description?.trim() ?? '';

    if (!description) {
      return fail({
        severity: FindingSeverity.MEDIUM,
        title: 'No business description',
        detail:
          'The profile has no description. This is the text a searcher reads when deciding whether to call. ' +
          `Write up to ${GOOGLE_MAX_LENGTH} characters describing what the business does, who it serves and where.`,
        evidence: { length: 0 },
        autoFixable: true,
        suggestedActionType: ActionType.UPDATE_DESCRIPTION,
      });
    }

    if (description.length < THIN_THRESHOLD) {
      return fail({
        severity: FindingSeverity.LOW,
        title: 'Business description is very short',
        detail:
          `The description is ${description.length} characters. There is room for up to ${GOOGLE_MAX_LENGTH}. ` +
          'A fuller description gives searchers more reason to choose this business over a competitor.',
        evidence: { length: description.length, maxLength: GOOGLE_MAX_LENGTH },
        autoFixable: true,
        suggestedActionType: ActionType.UPDATE_DESCRIPTION,
      });
    }

    return pass();
  },
};
