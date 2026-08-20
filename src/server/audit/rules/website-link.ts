import { ActionType, AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, type RuleDefinition } from '@/server/audit/types';

/**
 * The website link is both a conversion path and a relevance signal connecting
 * the profile to the site. For a multi-location business it should point at the
 * specific location page, not the homepage.
 */
export const websiteLinkRule: RuleDefinition = {
  id: 'gbp.contact.website_missing',
  category: 'contact',
  scope: AuditScope.GBP,
  title: 'A website is linked',
  weight: 10,
  requires: ['profile'],

  evaluate(ctx) {
    if (ctx.profile.websiteUri) return pass();

    return fail({
      severity: FindingSeverity.HIGH,
      title: 'No website is linked',
      detail:
        'The website link is a primary conversion path from the profile, and the profile-to-site connection ' +
        'is itself a relevance signal. For a business with several locations, link the location page rather ' +
        'than the homepage.',
      evidence: { websiteUri: null },
      autoFixable: true,
      suggestedActionType: ActionType.UPDATE_WEBSITE,
    });
  },
};
