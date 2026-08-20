import { ActionType, AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, type RuleDefinition } from '@/server/audit/types';

/**
 * Calls from the local pack are among the highest-intent actions a searcher
 * takes, and Google measures them directly (CALL_CLICKS). No number means the
 * call button does not render and that demand is lost unmeasured.
 */
export const phoneNumberRule: RuleDefinition = {
  id: 'gbp.contact.phone_missing',
  category: 'contact',
  scope: AuditScope.GBP,
  title: 'A primary phone number is set',
  weight: 10,
  requires: ['profile'],

  evaluate(ctx) {
    if (ctx.profile.phoneNumbers?.primaryPhone) return pass();

    return fail({
      severity: FindingSeverity.HIGH,
      title: 'No phone number is set',
      detail:
        'Without a primary phone number the call button does not appear on the profile. Calls are one of ' +
        'the highest-intent actions a local searcher takes, so this is direct lost demand.',
      evidence: { primaryPhone: null },
      autoFixable: true,
      suggestedActionType: ActionType.UPDATE_PHONE,
    });
  },
};
