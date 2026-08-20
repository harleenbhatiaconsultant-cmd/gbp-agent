import { AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, skip, type RuleDefinition } from '@/server/audit/types';

const MEANINGFUL_THRESHOLD = 10;

/**
 * Review count is a well-established local ranking factor, with the sharpest
 * gains at low counts — the first ten matter far more than the next fifty.
 *
 * Not auto-fixable, and deliberately so: the only compliant way to get reviews
 * is to ask every customer without screening them. Filtering requests by
 * expected sentiment is review gating, which Google prohibits and which this
 * platform will not implement.
 */
export const reviewVolumeRule: RuleDefinition = {
  id: 'gbp.reviews.volume',
  category: 'reviews',
  scope: AuditScope.GBP,
  title: 'Profile has a meaningful number of reviews',
  weight: 12,
  requires: ['reviews'],

  evaluate(ctx) {
    if (!ctx.reviews) {
      return skip('Reviews have not been synced for this location yet.');
    }

    if (ctx.reviews.totalCount >= MEANINGFUL_THRESHOLD) return pass();

    return fail({
      severity:
        ctx.reviews.totalCount === 0 ? FindingSeverity.HIGH : FindingSeverity.MEDIUM,
      title:
        ctx.reviews.totalCount === 0
          ? 'This profile has no reviews'
          : `Only ${ctx.reviews.totalCount} reviews`,
      detail:
        `Local ranking improves sharply over the first ~${MEANINGFUL_THRESHOLD} reviews. ` +
        'Ask every customer, without screening for who is likely to leave a positive one — ' +
        'selective soliciting is against Google policy and carries regulatory risk.',
      evidence: {
        totalCount: ctx.reviews.totalCount,
        threshold: MEANINGFUL_THRESHOLD,
        averageRating: ctx.reviews.averageRating,
      },
      autoFixable: false,
    });
  },
};
