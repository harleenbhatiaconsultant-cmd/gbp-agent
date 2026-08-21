/**
 * Separation of duties: the person who proposes a change may never approve it.
 *
 * This is an ABSOLUTE rule. There is no configuration flag, no plan tier and no
 * single-operator exemption, deliberately:
 *
 *   An exception built for solo use outlives its usefulness. It gets added when
 *   an organization has one admin, and it is still there — silently disabling
 *   the only check on unilateral changes to a customer's listing — long after
 *   the team has grown. The moment such a flag exists, the guarantee stops
 *   being "two people saw this" and becomes "two people saw this, unless".
 *
 * The cost is real and intended: a one-person organization cannot approve its
 * own proposals. The remedy is to invite a second owner or admin, which is a
 * deliberate act by a human, not a setting. Callers should surface that plainly
 * rather than presenting approval as broken.
 *
 * Why this lives in the policy layer rather than inside `approveChange`: it is a
 * compliance rule about who may authorize a mutation, alongside the guardrails
 * that decide what may be mutated. Keeping it here means the rule is findable
 * with the others and testable on its own.
 *
 * NOT covered here, deliberately:
 *   - Rejecting your own proposal is always allowed. It moves in the safe
 *     direction, and forcing a second person to decline obvious mistakes would
 *     train people to rubber-stamp.
 *   - Auto-apply is a different mechanism entirely: no human approves, so there
 *     is no self-approval to prevent. It is governed by `canAutoApply`, which
 *     requires explicit per-action opt-in and refuses anything above LOW risk.
 */

import { ForbiddenError } from '@/server/errors';

export interface ApprovalSubject {
  /** Who proposed the change. Null for system-generated proposals. */
  requestedByUserId: string | null;
}

export interface ApprovalActor {
  userId: string;
}

/**
 * Throws when the approver is the proposer.
 *
 * A system-generated proposal (`requestedByUserId` null) has no proposer, so
 * any authorized human may approve it — that IS the second pair of eyes.
 */
export function assertSeparationOfDuties(
  request: ApprovalSubject,
  approver: ApprovalActor,
): void {
  if (request.requestedByUserId === null) return;

  if (request.requestedByUserId === approver.userId) {
    throw new ForbiddenError(
      'You proposed this change, so you cannot approve it. Changes to a business profile ' +
        'require a second pair of eyes. If you are the only owner or admin in this ' +
        'organization, invite another one from Settings → Members.',
      { reason: 'separation_of_duties' },
    );
  }
}

/**
 * Non-throwing form, for deciding whether to render an approve control.
 * The UI uses this to explain why approval is unavailable rather than
 * presenting a button that always fails.
 */
export function canApprove(request: ApprovalSubject, approver: ApprovalActor): boolean {
  return request.requestedByUserId !== approver.userId;
}
