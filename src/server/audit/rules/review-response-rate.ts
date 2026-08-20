import { ActionType, AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import { fail, pass, skip, type RuleDefinition } from '@/server/audit/types';

const TARGET_RESPONSE_RATE = 0.9;

/**
 * Owner responses are one of the few review-side factors fully under the
 * owner's control, and one Google explicitly encourages.
 *
 * Auto-fixable in the sense that a reply is an API write — but the reply text
 * is AI-drafted and approval-gated, never posted unattended.
 */
export const reviewResponseRateRule: RuleDefinition = {
  id: 'gbp.reviews.response_rate',
  category: 'reviews',
  scope: AuditScope.GBP,
  title: 'Reviews are being responded to',
  weight: 10,
  requires: ['reviews'],

  evaluate(ctx) {
    if (!ctx.reviews) {
      return skip('Reviews have not been synced for this location yet.');
    }
    if (ctx.reviews.totalCount === 0) {
      return skip('There are no reviews to respond to.');
    }

    const answered = ctx.reviews.totalCount - ctx.reviews.unansweredCount;
    const rate = answered / ctx.reviews.totalCount;

    if (rate >= TARGET_RESPONSE_RATE) return pass();

    return fail({
      severity:
        ctx.reviews.unansweredCount > 10 ? FindingSeverity.HIGH : FindingSeverity.MEDIUM,
      title: `${ctx.reviews.unansweredCount} reviews have no owner response`,
      detail:
        `Responses are at ${Math.round(rate * 100)}% against a ${Math.round(TARGET_RESPONSE_RATE * 100)}% target. ` +
        'Responding shows prospective customers the business is active and engaged, and Google explicitly ' +
        'encourages it. Negative reviews matter most — a measured reply is read by everyone who comes after.',
      evidence: {
        totalCount: ctx.reviews.totalCount,
        unansweredCount: ctx.reviews.unansweredCount,
        responseRate: Number(rate.toFixed(2)),
      },
      autoFixable: true,
      suggestedActionType: ActionType.REPLY_TO_REVIEW,
    });
  },
};
