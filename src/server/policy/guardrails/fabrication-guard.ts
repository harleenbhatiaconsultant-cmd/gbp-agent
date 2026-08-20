import { FindingSeverity, PolicyDecisionType } from '@/generated/prisma/enums';
import { FACTUAL_ACTIONS } from '@/schemas/actions';
import type { Guardrail, GuardrailFinding } from '@/server/policy/types';

/**
 * A model may draft prose. It may never be the SOURCE OF A FACT.
 *
 * This is the guardrail that stops the most damaging failure mode of an
 * AI-assisted profile tool: a plausible-sounding phone number, address or set
 * of opening hours that nobody ever verified being written to a real listing.
 * A customer who misses calls because the platform invented a number has been
 * actively harmed, and the error looks authoritative.
 *
 * Every payload carries a `sourceRef`. For factual actions the source must be
 * something outside the model — a person, the website, the existing profile, or
 * a supplied document. `AI_GENERATED` is accepted only for narrative fields
 * such as the business description, where the model is genuinely the author.
 */

const NARRATIVE_SOURCE = 'AI_GENERATED';

export const fabricationGuardrail: Guardrail = {
  id: 'policy.source.fabrication',
  title: 'Factual values come from a real source, not the model',

  appliesTo() {
    // Every action carries a sourceRef, so every action is checked.
    return true;
  },

  evaluate(ctx) {
    const findings: GuardrailFinding[] = [];
    const sourceRef = ctx.payload.sourceRef as { kind?: string; detail?: string } | undefined;

    if (!sourceRef?.kind) {
      findings.push({
        ruleId: 'policy.source.missing',
        decision: PolicyDecisionType.BLOCK,
        severity: FindingSeverity.CRITICAL,
        detail:
          'This change carries no source attribution. Every proposed value must record where it came ' +
          'from, so that a change can be traced back to something a person can verify.',
        evidence: { actionType: ctx.actionType },
      });
      return findings;
    }

    if (FACTUAL_ACTIONS.has(ctx.actionType) && sourceRef.kind === NARRATIVE_SOURCE) {
      findings.push({
        ruleId: 'policy.source.ai_generated_fact',
        decision: PolicyDecisionType.BLOCK,
        severity: FindingSeverity.CRITICAL,
        detail:
          `${ctx.actionType} changes a fact about the business, and this payload names the model as its ` +
          'source. A model may draft prose but may never originate a phone number, address, category or ' +
          'set of opening hours. Supply the value from the customer, their website, or a document.',
        evidence: { actionType: ctx.actionType, sourceKind: sourceRef.kind },
      });
    }

    return findings;
  },
};
