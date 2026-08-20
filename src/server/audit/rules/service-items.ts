import { AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, type RuleDefinition } from '@/server/audit/types';

/**
 * Services listed on the profile let it match longer, more specific queries.
 * Low weight: helpful, but well behind category, location and hours.
 */
export const serviceItemsRule: RuleDefinition = {
  id: 'gbp.content.service_items',
  category: 'content',
  scope: AuditScope.GBP,
  title: 'Services are listed on the profile',
  weight: 5,
  requires: ['profile'],

  evaluate(ctx) {
    const services = ctx.profile.serviceItems ?? [];
    if (services.length > 0) return pass();

    return fail({
      severity: FindingSeverity.LOW,
      title: 'No services are listed',
      detail:
        'Listing individual services helps the profile match more specific searches than the category alone ' +
        'can cover. Add the services the business actually offers — do not pad the list with keywords.',
      evidence: { serviceItemCount: 0 },
      autoFixable: false,
    });
  },
};
