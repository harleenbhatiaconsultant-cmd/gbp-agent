import { ActionType, FindingSeverity, PolicyDecisionType } from '@/generated/prisma/enums';
import type { Guardrail, GuardrailFinding } from '@/server/policy/types';

/**
 * The primary category is the strongest single ranking signal, and a wrong one
 * is the most damaging non-fatal profile error there is. Changing it is never
 * routine.
 *
 * Always REQUIRE_HUMAN. Additionally blocks structurally invalid sets — a
 * duplicate between primary and additional categories, or an implausible
 * number of them.
 */

const MAX_ADDITIONAL_CATEGORIES = 9;

export const categoryIntegrityGuardrail: Guardrail = {
  id: 'policy.category.integrity',
  title: 'Category changes are deliberate and well-formed',

  appliesTo(actionType) {
    return actionType === ActionType.UPDATE_CATEGORIES;
  },

  evaluate(ctx) {
    const findings: GuardrailFinding[] = [];
    const primary = String(ctx.payload.primaryCategoryId ?? '');
    const additional = (ctx.payload.additionalCategoryIds as string[] | undefined) ?? [];

    if (additional.includes(primary)) {
      findings.push({
        ruleId: 'policy.category.duplicate_primary',
        decision: PolicyDecisionType.BLOCK,
        severity: FindingSeverity.HIGH,
        detail:
          'The primary category also appears in the additional categories. Google rejects this, and it ' +
          'wastes one of the limited secondary slots.',
        evidence: { primary, additional },
      });
    }

    const duplicates = additional.filter((id, index) => additional.indexOf(id) !== index);
    if (duplicates.length > 0) {
      findings.push({
        ruleId: 'policy.category.duplicates',
        decision: PolicyDecisionType.BLOCK,
        severity: FindingSeverity.MEDIUM,
        detail: `Duplicate categories in the request: ${[...new Set(duplicates)].join(', ')}.`,
        evidence: { duplicates },
      });
    }

    if (additional.length > MAX_ADDITIONAL_CATEGORIES) {
      findings.push({
        ruleId: 'policy.category.too_many',
        decision: PolicyDecisionType.BLOCK,
        severity: FindingSeverity.MEDIUM,
        detail:
          `${additional.length} additional categories requested; Google allows at most ` +
          `${MAX_ADDITIONAL_CATEGORIES}.`,
        evidence: { count: additional.length },
      });
    }

    const currentPrimary = ctx.currentProfile.categories?.primaryCategory?.name;
    if (currentPrimary && currentPrimary !== primary) {
      findings.push({
        ruleId: 'policy.category.primary_change_requires_human',
        decision: PolicyDecisionType.REQUIRE_HUMAN,
        severity: FindingSeverity.HIGH,
        detail:
          `This changes the primary category from ${currentPrimary} to ${primary}. The primary category is ` +
          'the strongest ranking signal a profile has; a person who knows the business must confirm it.',
        evidence: { from: currentPrimary, to: primary },
      });
    } else if (findings.length === 0) {
      findings.push({
        ruleId: 'policy.category.requires_human',
        decision: PolicyDecisionType.REQUIRE_HUMAN,
        severity: FindingSeverity.MEDIUM,
        detail: 'Category changes require a named human approver.',
        evidence: { primary, additional },
      });
    }

    return findings;
  },
};
