import { AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, skip, type RuleDefinition } from '@/server/audit/types';

const STALE_AFTER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A steady trickle of recent reviews signals an active business. A profile whose
 * newest review is months old looks dormant regardless of its total count.
 *
 * As with volume: the compliant remedy is asking every customer, never
 * screening them first.
 */
export const reviewVelocityRule: RuleDefinition = {
  id: 'gbp.reviews.velocity',
  category: 'reviews',
  scope: AuditScope.GBP,
  title: 'Reviews are arriving recently',
  weight: 8,
  requires: ['reviews'],

  evaluate(ctx) {
    if (!ctx.reviews) {
      return skip('Reviews have not been synced for this location yet.');
    }
    if (!ctx.reviews.newestReviewAt) {
      return skip('No reviews exist, so velocity cannot be assessed — see the review volume check.');
    }

    const daysSince = Math.floor(
      (ctx.evaluatedAt.getTime() - ctx.reviews.newestReviewAt.getTime()) / DAY_MS,
    );

    if (daysSince <= STALE_AFTER_DAYS) return pass();

    return fail({
      severity: daysSince > 90 ? FindingSeverity.HIGH : FindingSeverity.MEDIUM,
      title: `No new reviews in ${daysSince} days`,
      detail:
        `The most recent review arrived ${daysSince} days ago. A profile with no recent reviews reads as ` +
        'dormant to both searchers and Google, even when the total count is healthy. Build a habit of asking ' +
        'every customer at the point of service.',
      evidence: {
        daysSinceNewestReview: daysSince,
        newestReviewAt: ctx.reviews.newestReviewAt.toISOString(),
        staleAfterDays: STALE_AFTER_DAYS,
      },
      autoFixable: false,
    });
  },
};
