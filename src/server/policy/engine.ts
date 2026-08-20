/**
 * The compliance policy engine.
 *
 * Runs every applicable guardrail, combines their verdicts (strictest wins),
 * and assigns a risk level. Nothing becomes an approvable ChangeRequest without
 * passing through here.
 *
 * Pure: no I/O. The one piece of state it needs — how many changes have already
 * been applied to this location today — is passed in by the caller, so the
 * engine stays testable against fixtures like the audit rules.
 */

import { FindingSeverity, PolicyDecisionType, RiskLevel } from '@/generated/prisma/enums';
import { BASELINE_ACTION_RISK } from '@/config/features';
import type { GuardrailContext, GuardrailFinding, PolicyResult } from '@/server/policy/types';
import { strictest } from '@/server/policy/types';
import { businessNameIntegrityGuardrail } from '@/server/policy/guardrails/business-name-integrity';
import { rankingClaimsGuardrail } from '@/server/policy/guardrails/ranking-claims';
import { keywordStuffingGuardrail } from '@/server/policy/guardrails/keyword-stuffing';
import { fabricationGuardrail } from '@/server/policy/guardrails/fabrication-guard';
import { categoryIntegrityGuardrail } from '@/server/policy/guardrails/category-integrity';
import { blastRadiusGuardrail } from '@/server/policy/guardrails/blast-radius';
import { logger } from '@/server/observability/logger';

export const GUARDRAILS = [
  // Source attribution first: a fabricated value should be refused before
  // anything spends effort assessing how it reads.
  fabricationGuardrail,
  businessNameIntegrityGuardrail,
  categoryIntegrityGuardrail,
  rankingClaimsGuardrail,
  keywordStuffingGuardrail,
  blastRadiusGuardrail,
] as const;

const RISK_ORDER: RiskLevel[] = [RiskLevel.LOW, RiskLevel.MEDIUM, RiskLevel.HIGH];

function escalate(level: RiskLevel, steps = 1): RiskLevel {
  const index = Math.min(RISK_ORDER.indexOf(level) + steps, RISK_ORDER.length - 1);
  return RISK_ORDER[index];
}

/**
 * Risk is a property of the action type PLUS the size of the change.
 * Replacing an entire description is not the same as fixing a typo in it, even
 * though both are UPDATE_DESCRIPTION.
 */
function assessRisk(ctx: GuardrailContext, findings: GuardrailFinding[]): RiskLevel {
  let risk = BASELINE_ACTION_RISK[ctx.actionType] ?? RiskLevel.MEDIUM;

  const hasSevereFinding = findings.some(
    (f) => f.severity === FindingSeverity.CRITICAL || f.severity === FindingSeverity.HIGH,
  );
  if (hasSevereFinding) risk = escalate(risk);

  // A change that removes existing published content is riskier than one that
  // fills a gap: there is something to lose.
  const current = ctx.currentProfile;

  if (ctx.actionType === 'UPDATE_DESCRIPTION') {
    const existing = current.profile?.description ?? '';
    const proposed = String(ctx.payload.description ?? '');
    if (existing.length > 0 && proposed.length < existing.length * 0.5) {
      risk = escalate(risk);
    }
  }

  if (ctx.actionType === 'UPDATE_REGULAR_HOURS') {
    const existingDays = new Set(
      (current.regularHours?.periods ?? []).map((p) => p.openDay).filter(Boolean),
    );
    const proposedPeriods = (ctx.payload.periods as Array<{ openDay?: string }> | undefined) ?? [];
    const proposedDays = new Set(proposedPeriods.map((p) => p.openDay).filter(Boolean));
    // Removing days a business currently advertises as open loses real custom.
    const removed = [...existingDays].filter((day) => !proposedDays.has(day as string));
    if (removed.length > 0) risk = escalate(risk);
  }

  return risk;
}

export function evaluatePolicy(ctx: GuardrailContext): PolicyResult {
  const findings: GuardrailFinding[] = [];

  for (const guardrail of GUARDRAILS) {
    if (!guardrail.appliesTo(ctx.actionType)) continue;

    try {
      findings.push(...guardrail.evaluate(ctx));
    } catch (error) {
      // A guardrail that throws must not become an accidental ALLOW. Fail closed.
      logger.error(
        { err: error, guardrailId: guardrail.id, actionType: ctx.actionType },
        'Guardrail threw; failing closed',
      );
      findings.push({
        ruleId: `${guardrail.id}.error`,
        decision: PolicyDecisionType.BLOCK,
        severity: FindingSeverity.CRITICAL,
        detail:
          `The "${guardrail.title}" compliance check could not be evaluated, so this change is refused. ` +
          'A change is never allowed through on the basis of a check that did not run.',
      });
    }
  }

  const decision = findings.reduce<PolicyDecisionType>(
    (acc, finding) => strictest(acc, finding.decision),
    PolicyDecisionType.ALLOW,
  );

  return {
    decision,
    riskLevel: assessRisk(ctx, findings),
    findings,
    blockers: findings.filter((f) => f.decision === PolicyDecisionType.BLOCK),
  };
}
