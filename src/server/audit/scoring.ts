/**
 * Health scoring.
 *
 * The scoring model is deliberately simple, because it has to be explainable to
 * a client who asks "why did my score drop?":
 *
 *   score = 100 × (weight of checks passed ÷ weight of checks that RAN)
 *
 * Skipped checks are excluded from BOTH sides. A rule that could not run
 * because reviews are not connected neither helps nor hurts the score — it
 * reduces COVERAGE, which is reported alongside the score and must be shown
 * with it. A 100 out of 40% coverage is not a healthy profile, and the UI has
 * to be able to say so.
 */

import type { AuditCategory, RuleDefinition, RuleOutcome } from '@/server/audit/types';

export interface RuleEvaluation {
  rule: RuleDefinition;
  outcome: RuleOutcome;
}

export interface CategoryScore {
  category: AuditCategory;
  earned: number;
  available: number;
  /** null when every rule in the category was skipped. */
  score: number | null;
  checksPassed: number;
  checksFailed: number;
  checksSkipped: number;
}

export interface HealthScore {
  /** 0-100, or null when no check could run at all. */
  score: number | null;
  earned: number;
  available: number;
  categories: CategoryScore[];
  coverage: {
    evaluated: number;
    skipped: number;
    total: number;
    /** Share of total rule weight that actually ran, 0-1. */
    weightRatio: number;
  };
  skippedReasons: Array<{ ruleId: string; title: string; reason: string }>;
}

export function computeHealthScore(evaluations: readonly RuleEvaluation[]): HealthScore {
  const byCategory = new Map<AuditCategory, CategoryScore>();

  let earned = 0;
  let available = 0;
  let totalWeight = 0;
  let evaluatedCount = 0;
  let skippedCount = 0;
  const skippedReasons: HealthScore['skippedReasons'] = [];

  for (const { rule, outcome } of evaluations) {
    totalWeight += rule.weight;

    const bucket = byCategory.get(rule.category) ?? {
      category: rule.category,
      earned: 0,
      available: 0,
      score: null,
      checksPassed: 0,
      checksFailed: 0,
      checksSkipped: 0,
    };

    if (outcome.status === 'skipped') {
      skippedCount += 1;
      bucket.checksSkipped += 1;
      skippedReasons.push({ ruleId: rule.id, title: rule.title, reason: outcome.reason });
    } else {
      evaluatedCount += 1;
      available += rule.weight;
      bucket.available += rule.weight;

      if (outcome.status === 'pass') {
        earned += rule.weight;
        bucket.earned += rule.weight;
        bucket.checksPassed += 1;
      } else {
        bucket.checksFailed += 1;
      }
    }

    byCategory.set(rule.category, bucket);
  }

  const categories = [...byCategory.values()].map((bucket) => ({
    ...bucket,
    score: bucket.available > 0 ? Math.round((bucket.earned / bucket.available) * 100) : null,
  }));

  return {
    score: available > 0 ? Math.round((earned / available) * 100) : null,
    earned,
    available,
    categories,
    coverage: {
      evaluated: evaluatedCount,
      skipped: skippedCount,
      total: evaluations.length,
      weightRatio: totalWeight > 0 ? Number((available / totalWeight).toFixed(3)) : 0,
    },
    skippedReasons,
  };
}

/** Plain-language band for the score. Used for UI colour, never for claims. */
export function scoreBand(score: number | null): 'unknown' | 'poor' | 'fair' | 'good' | 'strong' {
  if (score === null) return 'unknown';
  if (score < 50) return 'poor';
  if (score < 70) return 'fair';
  if (score < 90) return 'good';
  return 'strong';
}
