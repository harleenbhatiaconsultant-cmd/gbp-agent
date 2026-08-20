/**
 * Audit engine and rule tests.
 *
 * Per DEVELOPMENT_PLAN.md §6 this is the highest-value test surface in the
 * product: the audit is what gets sold, and it has to be defensible when a
 * client asks why their score is what it is. Every rule gets a passing and a
 * failing case, and the scoring model's honesty properties are asserted
 * explicitly.
 */

import { describe, it, expect } from 'vitest';
import { FindingSeverity } from '@/generated/prisma/enums';
import { runAudit } from '@/server/audit/engine';
import { RULESET, assertRulesetIsValid } from '@/server/audit/ruleset';
import { computeHealthScore, scoreBand } from '@/server/audit/scoring';
import { RULESET_VERSION, type RuleContext, type ReviewSummary } from '@/server/audit/types';
import type { GbpLocationResource } from '@/server/integrations/google/types';
import {
  healthyLocation,
  neglectedLocation,
  closedLocation,
  serviceAreaLocation,
} from '../fixtures/locations';

const EVALUATED_AT = new Date('2026-08-20T12:00:00Z');

function contextFor(
  profile: GbpLocationResource,
  reviews?: ReviewSummary,
): RuleContext {
  return { profile, evaluatedAt: EVALUATED_AT, reviews };
}

function findingIds(profile: GbpLocationResource, reviews?: ReviewSummary): string[] {
  return runAudit(contextFor(profile, reviews)).findings.map((f) => f.ruleId);
}

describe('ruleset integrity', () => {
  it('has no duplicate rule ids and no zero weights', () => {
    expect(() => assertRulesetIsValid()).not.toThrow();
  });

  it('gives every rule a stable id namespaced by surface', () => {
    for (const rule of RULESET) {
      expect(rule.id).toMatch(/^gbp\.[a-z_]+\.[a-z_]+$/);
    }
  });
});

describe('healthy profile', () => {
  it('produces no profile-scoped findings', () => {
    const ids = findingIds(healthyLocation);
    expect(ids).toEqual([]);
  });

  it('scores 100 across the checks that ran', () => {
    const result = runAudit(contextFor(healthyLocation));
    expect(result.health.score).toBe(100);
  });

  it('reports the ruleset version so a score stays attributable', () => {
    expect(runAudit(contextFor(healthyLocation)).rulesetVersion).toBe(RULESET_VERSION);
  });
});

describe('neglected profile', () => {
  const ids = findingIds(neglectedLocation);

  it('flags the missing primary category as critical', () => {
    const result = runAudit(contextFor(neglectedLocation));
    const finding = result.findings.find((f) => f.ruleId === 'gbp.category.primary_missing');
    expect(finding?.severity).toBe(FindingSeverity.CRITICAL);
  });

  it('flags a missing location as critical', () => {
    expect(ids).toContain('gbp.profile.location_missing');
  });

  it('flags missing contact paths', () => {
    expect(ids).toContain('gbp.contact.phone_missing');
    expect(ids).toContain('gbp.contact.website_missing');
  });

  it('flags missing hours, description and services', () => {
    expect(ids).toContain('gbp.hours.regular_missing');
    expect(ids).toContain('gbp.content.description');
    expect(ids).toContain('gbp.content.service_items');
  });

  it('flags Google-applied overrides and pending edits separately', () => {
    expect(ids).toContain('gbp.profile.google_updated');
    expect(ids).toContain('gbp.profile.pending_edits');
  });

  it('scores poorly', () => {
    const result = runAudit(contextFor(neglectedLocation));
    expect(result.health.score).not.toBeNull();
    expect(result.health.score!).toBeLessThan(40);
    expect(scoreBand(result.health.score)).toBe('poor');
  });
});

describe('permanently closed profile', () => {
  it('flags the closure as critical', () => {
    const result = runAudit(contextFor(closedLocation));
    const finding = result.findings.find((f) => f.ruleId === 'gbp.profile.open_status');
    expect(finding?.severity).toBe(FindingSeverity.CRITICAL);
  });

  it('does not also demand opening hours from a closed business', () => {
    // Flagging missing hours on a permanently closed listing is noise, not a finding.
    expect(findingIds(closedLocation)).not.toContain('gbp.hours.regular_missing');
    expect(findingIds(closedLocation)).not.toContain('gbp.hours.special_missing');
  });
});

describe('service-area business', () => {
  it('accepts a service area in place of a storefront address', () => {
    expect(findingIds(serviceAreaLocation)).not.toContain('gbp.profile.location_missing');
  });
});

describe('review rules without synced reviews', () => {
  const result = runAudit(contextFor(healthyLocation));

  it('skips them rather than passing them', () => {
    const skippedIds = result.health.skippedReasons.map((s) => s.ruleId);
    expect(skippedIds).toContain('gbp.reviews.volume');
    expect(skippedIds).toContain('gbp.reviews.response_rate');
    expect(skippedIds).toContain('gbp.reviews.velocity');
  });

  it('excludes them from the score rather than counting them as passes', () => {
    // The honesty property: coverage drops, the score does not inflate.
    expect(result.health.coverage.skipped).toBe(3);
    expect(result.health.coverage.weightRatio).toBeLessThan(1);
  });

  it('gives a reason for each skipped check', () => {
    for (const skipped of result.health.skippedReasons) {
      expect(skipped.reason.length).toBeGreaterThan(10);
    }
  });
});

describe('review rules with synced reviews', () => {
  const strongReviews: ReviewSummary = {
    totalCount: 48,
    averageRating: 4.7,
    unansweredCount: 2,
    newestReviewAt: new Date('2026-08-14T00:00:00Z'),
    newestOwnerReplyAt: new Date('2026-08-15T00:00:00Z'),
  };

  const weakReviews: ReviewSummary = {
    totalCount: 3,
    averageRating: 3.1,
    unansweredCount: 3,
    newestReviewAt: new Date('2026-01-04T00:00:00Z'),
    newestOwnerReplyAt: null,
  };

  it('passes a well-tended review profile', () => {
    expect(findingIds(healthyLocation, strongReviews)).toEqual([]);
  });

  it('flags low volume, no responses and stale velocity', () => {
    const ids = findingIds(healthyLocation, weakReviews);
    expect(ids).toContain('gbp.reviews.volume');
    expect(ids).toContain('gbp.reviews.response_rate');
    expect(ids).toContain('gbp.reviews.velocity');
  });

  it('raises severity as a review drought lengthens', () => {
    const result = runAudit(contextFor(healthyLocation, weakReviews));
    const velocity = result.findings.find((f) => f.ruleId === 'gbp.reviews.velocity');
    // Newest review is ~7 months before EVALUATED_AT.
    expect(velocity?.severity).toBe(FindingSeverity.HIGH);
  });

  it('never proposes an automated fix for getting more reviews', () => {
    // The only compliant remedy is asking every customer. Anything the platform
    // could automate here would be review gating, which is prohibited.
    const result = runAudit(contextFor(healthyLocation, weakReviews));
    const volume = result.findings.find((f) => f.ruleId === 'gbp.reviews.volume');
    expect(volume?.autoFixable).toBe(false);
    expect(volume?.suggestedActionType).toBeNull();
  });

  it('skips response rate when there are no reviews at all', () => {
    const noReviews: ReviewSummary = {
      totalCount: 0,
      averageRating: 0,
      unansweredCount: 0,
      newestReviewAt: null,
      newestOwnerReplyAt: null,
    };
    const result = runAudit(contextFor(healthyLocation, noReviews));
    const skippedIds = result.health.skippedReasons.map((s) => s.ruleId);
    expect(skippedIds).toContain('gbp.reviews.response_rate');
    // But volume itself is evaluated, and fails.
    expect(result.findings.map((f) => f.ruleId)).toContain('gbp.reviews.volume');
  });
});

describe('findings', () => {
  it('carries a stable fingerprint so an issue can be tracked across runs', () => {
    const first = runAudit(contextFor(neglectedLocation)).findings;
    const second = runAudit(contextFor(neglectedLocation)).findings;
    expect(first.map((f) => f.fingerprint)).toEqual(second.map((f) => f.fingerprint));
  });

  it('gives every finding actionable detail, not just a label', () => {
    for (const finding of runAudit(contextFor(neglectedLocation)).findings) {
      expect(finding.detail.length).toBeGreaterThan(40);
      expect(finding.title.length).toBeGreaterThan(5);
    }
  });

  it('only suggests an action type when the finding is auto-fixable', () => {
    for (const finding of runAudit(contextFor(neglectedLocation)).findings) {
      if (finding.suggestedActionType) expect(finding.autoFixable).toBe(true);
    }
  });
});

describe('engine resilience', () => {
  it('contains a throwing rule as a skip instead of failing the audit', () => {
    const explodingRule = {
      id: 'gbp.test.exploding',
      category: 'content' as const,
      scope: 'GBP' as const,
      title: 'Always throws',
      weight: 5,
      requires: ['profile'] as const,
      evaluate() {
        throw new Error('boom');
      },
    };

    const result = runAudit(contextFor(healthyLocation), [...RULESET, explodingRule]);

    expect(result.health.skippedReasons.map((s) => s.ruleId)).toContain('gbp.test.exploding');
    // The rest of the audit still produced a score.
    expect(result.health.score).toBe(100);
  });
});

describe('scoring model', () => {
  it('returns a null score when nothing could be evaluated', () => {
    const health = computeHealthScore([
      {
        rule: RULESET[0],
        outcome: { status: 'skipped', reason: 'no data' },
      },
    ]);
    expect(health.score).toBeNull();
    expect(scoreBand(null)).toBe('unknown');
  });

  it('reports coverage alongside the score', () => {
    const result = runAudit(contextFor(healthyLocation));
    expect(result.health.coverage.total).toBe(RULESET.length);
    expect(result.health.coverage.evaluated + result.health.coverage.skipped).toBe(
      RULESET.length,
    );
  });

  it('breaks the score down by category so a drop is explainable', () => {
    const result = runAudit(contextFor(neglectedLocation));
    const categories = result.health.categories.map((c) => c.category);
    expect(categories).toContain('categories');
    expect(categories).toContain('contact');
    for (const category of result.health.categories) {
      expect(category.earned).toBeLessThanOrEqual(category.available);
    }
  });
});
