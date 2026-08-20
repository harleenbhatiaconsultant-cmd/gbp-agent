import { AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, type RuleDefinition } from '@/server/audit/types';

/**
 * Submitted changes awaiting Google review are not live. Until they are
 * approved the published profile still shows the previous values, which is a
 * common source of "we already fixed that" confusion.
 */
export const pendingEditsRule: RuleDefinition = {
  id: 'gbp.profile.pending_edits',
  category: 'profile_completeness',
  scope: AuditScope.GBP,
  title: 'No edits are stuck awaiting review',
  weight: 4,
  requires: ['profile'],

  evaluate(ctx) {
    if (!ctx.profile.metadata?.hasPendingEdits) return pass();

    return fail({
      severity: FindingSeverity.MEDIUM,
      title: 'Profile has edits pending Google review',
      detail:
        'Submitted changes are awaiting Google review and are not yet published. The live profile still shows ' +
        'the previous values until they are approved.',
      evidence: { hasPendingEdits: true },
      autoFixable: false,
    });
  },
};
