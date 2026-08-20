import { FindingSeverity, PolicyDecisionType } from '@/generated/prisma/enums';
import { env } from '@/config/env.server';
import type { Guardrail, GuardrailFinding } from '@/server/policy/types';

/**
 * Caps how much can change on one profile in a day.
 *
 * This is a containment measure, not an optimization one. If a rule regresses,
 * a prompt misbehaves, or someone bulk-approves by mistake, the damage is
 * bounded to a handful of edits on a handful of profiles instead of a rewrite
 * of a customer's entire listing — and it stays inside Google's own edit rate
 * limits along the way.
 */

export const blastRadiusGuardrail: Guardrail = {
  id: 'policy.limits.blast_radius',
  title: 'Daily change limit per location',

  appliesTo() {
    return true;
  },

  evaluate(ctx): GuardrailFinding[] {
    const limit = env.GBP_MAX_CHANGES_PER_LOCATION_PER_DAY;

    if (ctx.changesAppliedToday >= limit) {
      return [
        {
          ruleId: 'policy.limits.daily_cap_reached',
          decision: PolicyDecisionType.BLOCK,
          severity: FindingSeverity.HIGH,
          detail:
            `${ctx.changesAppliedToday} changes have already been applied to this location today, which ` +
            `meets the limit of ${limit}. Further changes are refused until tomorrow. Raise ` +
            'GBP_MAX_CHANGES_PER_LOCATION_PER_DAY deliberately if a bulk correction is genuinely needed.',
          evidence: { changesAppliedToday: ctx.changesAppliedToday, limit },
        },
      ];
    }

    // Approaching the cap is worth a human glance rather than silent approval.
    if (ctx.changesAppliedToday >= Math.floor(limit * 0.8)) {
      return [
        {
          ruleId: 'policy.limits.daily_cap_near',
          decision: PolicyDecisionType.REQUIRE_HUMAN,
          severity: FindingSeverity.LOW,
          detail:
            `${ctx.changesAppliedToday} of ${limit} daily changes have been applied to this location. ` +
            'A person should confirm the remaining ones are intended.',
          evidence: { changesAppliedToday: ctx.changesAppliedToday, limit },
        },
      ];
    }

    return [];
  },
};
