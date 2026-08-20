import { ActionType, AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, type RuleDefinition } from '@/server/audit/types';

/**
 * A profile must tell Google WHERE it operates — either a storefront address or
 * a defined service area. Neither means Google has no geographic signal, which
 * is fatal for local pack eligibility.
 *
 * Having both is normal and correct for businesses that serve customers at a
 * storefront and travel to them.
 */
export const locationPresenceRule: RuleDefinition = {
  id: 'gbp.profile.location_missing',
  category: 'profile_completeness',
  scope: AuditScope.GBP,
  title: 'A storefront address or service area is defined',
  weight: 18,
  requires: ['profile'],

  evaluate(ctx) {
    const hasAddress = Boolean(ctx.profile.storefrontAddress?.addressLines?.length);
    const hasServiceArea = Boolean(ctx.profile.serviceArea?.places?.placeInfos?.length);

    if (hasAddress || hasServiceArea) return pass();

    return fail({
      severity: FindingSeverity.CRITICAL,
      title: 'No storefront address or service area is set',
      detail:
        'Local pack results are ranked partly by proximity to the searcher. With neither an address nor a ' +
        'service area, Google has no location to compute that from and the profile is unlikely to surface at all.',
      evidence: { hasStorefrontAddress: false, hasServiceArea: false },
      autoFixable: true,
      suggestedActionType: ActionType.UPDATE_ADDRESS,
    });
  },
};
