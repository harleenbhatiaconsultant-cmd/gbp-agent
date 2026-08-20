/**
 * The audit engine.
 *
 * Runs the ruleset against one snapshot and returns a structured result. It
 * performs NO I/O — persistence is the service layer's job — which is what lets
 * the whole engine be tested against JSON fixtures with no database.
 *
 * A rule that throws is contained: it is recorded as skipped with the error as
 * its reason, and the rest of the audit completes. One bad rule must not cost
 * the client their entire report.
 */

import type { AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import type { ActionType } from '@/generated/prisma/enums';
import { RULESET, assertRulesetIsValid } from '@/server/audit/ruleset';
import { computeHealthScore, type HealthScore, type RuleEvaluation } from '@/server/audit/scoring';
import {
  RULESET_VERSION,
  type AuditCategory,
  type RuleContext,
  type RuleDefinition,
} from '@/server/audit/types';
import { logger } from '@/server/observability/logger';

export interface EngineFinding {
  ruleId: string;
  category: AuditCategory;
  scope: AuditScope;
  severity: FindingSeverity;
  title: string;
  detail: string;
  evidence: Record<string, unknown> | null;
  autoFixable: boolean;
  suggestedActionType: ActionType | null;
  /**
   * Stable identity for "the same issue" across runs, so a finding can be
   * tracked from opened through resolved rather than duplicated every week.
   */
  fingerprint: string;
}

export interface AuditEngineResult {
  rulesetVersion: string;
  evaluatedAt: Date;
  findings: EngineFinding[];
  health: HealthScore;
  evaluations: RuleEvaluation[];
}

function fingerprintFor(rule: RuleDefinition, discriminator?: string): string {
  return discriminator ? `${rule.id}#${discriminator}` : rule.id;
}

export function runAudit(
  ctx: RuleContext,
  rules: readonly RuleDefinition[] = RULESET,
): AuditEngineResult {
  assertRulesetIsValid(rules);

  const evaluations: RuleEvaluation[] = [];
  const findings: EngineFinding[] = [];

  for (const rule of rules) {
    let outcome;

    try {
      outcome = rule.evaluate(ctx);
    } catch (error) {
      // Containment: a broken rule degrades coverage, it does not fail the audit.
      logger.error({ err: error, ruleId: rule.id }, 'Audit rule threw; recording as skipped');
      outcome = {
        status: 'skipped' as const,
        reason: 'This check could not be evaluated due to an internal error.',
      };
    }

    evaluations.push({ rule, outcome });

    if (outcome.status === 'fail') {
      for (const draft of outcome.findings) {
        findings.push({
          ruleId: rule.id,
          category: rule.category,
          scope: rule.scope,
          severity: draft.severity,
          title: draft.title,
          detail: draft.detail,
          evidence: draft.evidence ?? null,
          autoFixable: draft.autoFixable,
          suggestedActionType: draft.suggestedActionType ?? null,
          fingerprint: fingerprintFor(rule, draft.discriminator),
        });
      }
    }
  }

  return {
    rulesetVersion: RULESET_VERSION,
    evaluatedAt: ctx.evaluatedAt,
    findings,
    health: computeHealthScore(evaluations),
    evaluations,
  };
}
