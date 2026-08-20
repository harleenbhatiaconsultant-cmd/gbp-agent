/**
 * Compliance guardrail tests.
 *
 * These are the adversarial cases from DEVELOPMENT_PLAN.md §6 — a keyword-
 * stuffed name, a ranking claim in generated copy, a model-invented fact. They
 * are the tests that must stay red-if-broken forever: each one corresponds to
 * something that gets a customer's listing suspended, or the business sued.
 */

import { describe, it, expect } from 'vitest';
import { ActionType, PolicyDecisionType, RiskLevel } from '@/generated/prisma/enums';
import { evaluatePolicy } from '@/server/policy/engine';
import type { GuardrailContext } from '@/server/policy/types';
import type { GbpLocationResource } from '@/server/integrations/google/types';
import { healthyLocation } from '../fixtures/locations';

function contextFor(
  actionType: ActionType,
  payload: Record<string, unknown>,
  overrides: Partial<GuardrailContext> = {},
): GuardrailContext {
  return {
    actionType,
    payload,
    currentProfile: healthyLocation as GbpLocationResource,
    changesAppliedToday: 0,
    ...overrides,
  };
}

const humanSource = { kind: 'USER_INPUT', detail: 'Confirmed with the owner by phone' };
const aiSource = { kind: 'AI_GENERATED', detail: 'Drafted by the assistant' };

describe('business name integrity', () => {
  it('BLOCKS a name that adds the city from the profile address', () => {
    // healthyLocation is in Portland, OR.
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_TITLE, {
        title: 'Northside Dental Care Portland',
        sourceRef: humanSource,
      }),
    );

    expect(result.decision).toBe(PolicyDecisionType.BLOCK);
    expect(result.blockers.map((b) => b.ruleId)).toContain('policy.name.location_stuffing');
  });

  it('BLOCKS a name that adds a service keyword', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_TITLE, {
        title: 'Northside Dental Care Dentist Clinic',
        sourceRef: humanSource,
      }),
    );

    expect(result.decision).toBe(PolicyDecisionType.BLOCK);
    expect(result.blockers.map((b) => b.ruleId)).toContain('policy.name.keyword_stuffing');
  });

  it('BLOCKS a name that adds marketing language', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_TITLE, {
        title: 'Best Northside Dental Care',
        sourceRef: humanSource,
      }),
    );

    expect(result.decision).toBe(PolicyDecisionType.BLOCK);
    expect(result.blockers.map((b) => b.ruleId)).toContain('policy.name.superlative');
  });

  it('allows a legitimate rebrand but still demands a human approver', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_TITLE, {
        title: 'Northside Family Dentistry',
        sourceRef: humanSource,
      }),
    );

    expect(result.decision).toBe(PolicyDecisionType.REQUIRE_HUMAN);
    expect(result.blockers).toHaveLength(0);
  });

  it('does not block a pure cleanup that only removes words', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_TITLE, {
        title: 'Northside Dental',
        sourceRef: humanSource,
      }),
    );
    expect(result.decision).toBe(PolicyDecisionType.REQUIRE_HUMAN);
  });
});

describe('ranking claims', () => {
  it('BLOCKS a guarantee in the business description', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_DESCRIPTION, {
        description:
          'We are the leading dental practice in the area and guarantee you will rank first for every search.',
        sourceRef: aiSource,
      }),
    );

    expect(result.decision).toBe(PolicyDecisionType.BLOCK);
    expect(result.blockers.map((b) => b.ruleId)).toContain('policy.content.ranking_claims');
  });

  it('BLOCKS "#1" style claims regardless of punctuation', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_DESCRIPTION, {
        description:
          'The #1 rated family dental practice serving patients for over twenty years with care and attention.',
        sourceRef: aiSource,
      }),
    );

    expect(result.decision).toBe(PolicyDecisionType.BLOCK);
  });

  it('allows ordinary descriptive prose', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_DESCRIPTION, {
        description:
          'A family dental practice offering routine cleanings, restorative work and emergency appointments, ' +
          'with evening availability on request and parking on site.',
        sourceRef: aiSource,
      }),
    );

    expect(result.decision).toBe(PolicyDecisionType.ALLOW);
  });
});

describe('keyword stuffing', () => {
  it('BLOCKS a description that repeats a term relentlessly', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_DESCRIPTION, {
        description:
          'Dentist Portland dentist services dentist appointments dentist cleaning dentist whitening ' +
          'dentist emergency dentist family dentist affordable dentist near dentist office dentist.',
        sourceRef: aiSource,
      }),
    );

    expect(result.decision).toBe(PolicyDecisionType.BLOCK);
    expect(result.blockers.map((b) => b.ruleId)).toContain('policy.content.keyword_stuffing');
  });

  it('does not flag short text where repetition is natural', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_DESCRIPTION, {
        description: 'Dental care for the whole family.',
        sourceRef: aiSource,
      }),
    );
    expect(result.decision).toBe(PolicyDecisionType.ALLOW);
  });
});

describe('fabrication guard', () => {
  it('BLOCKS a phone number the model invented', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_PHONE, {
        primaryPhone: '+1 555-0199',
        additionalPhones: [],
        sourceRef: aiSource,
      }),
    );

    expect(result.decision).toBe(PolicyDecisionType.BLOCK);
    expect(result.blockers.map((b) => b.ruleId)).toContain('policy.source.ai_generated_fact');
  });

  it('BLOCKS model-invented opening hours', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_REGULAR_HOURS, {
        periods: [
          {
            openDay: 'MONDAY',
            openTime: { hours: 9, minutes: 0 },
            closeDay: 'MONDAY',
            closeTime: { hours: 17, minutes: 0 },
          },
        ],
        sourceRef: aiSource,
      }),
    );

    expect(result.decision).toBe(PolicyDecisionType.BLOCK);
  });

  it('allows the model to author narrative prose', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_DESCRIPTION, {
        description:
          'A neighbourhood dental practice providing preventive and restorative care for families, with ' +
          'appointments available outside standard working hours.',
        sourceRef: aiSource,
      }),
    );
    expect(result.decision).toBe(PolicyDecisionType.ALLOW);
  });

  it('BLOCKS any payload with no source attribution at all', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_WEBSITE, { websiteUri: 'https://example.com' }),
    );

    expect(result.decision).toBe(PolicyDecisionType.BLOCK);
    expect(result.blockers.map((b) => b.ruleId)).toContain('policy.source.missing');
  });

  it('accepts a human-sourced fact', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_WEBSITE, {
        websiteUri: 'https://northsidedental.example/portland',
        sourceRef: humanSource,
      }),
    );
    expect(result.decision).toBe(PolicyDecisionType.ALLOW);
  });
});

describe('category integrity', () => {
  it('always requires a human for a primary category change', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_CATEGORIES, {
        primaryCategoryId: 'gcid:orthodontist',
        additionalCategoryIds: [],
        sourceRef: humanSource,
      }),
    );

    expect(result.decision).toBe(PolicyDecisionType.REQUIRE_HUMAN);
  });

  it('BLOCKS a primary category duplicated in the secondary list', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_CATEGORIES, {
        primaryCategoryId: 'gcid:dentist',
        additionalCategoryIds: ['gcid:dentist'],
        sourceRef: humanSource,
      }),
    );

    expect(result.decision).toBe(PolicyDecisionType.BLOCK);
    expect(result.blockers.map((b) => b.ruleId)).toContain('policy.category.duplicate_primary');
  });
});

describe('blast radius', () => {
  it('BLOCKS once the daily cap for a location is reached', () => {
    const result = evaluatePolicy(
      contextFor(
        ActionType.UPDATE_DESCRIPTION,
        {
          description: 'A neighbourhood dental practice providing preventive and restorative care.',
          sourceRef: aiSource,
        },
        { changesAppliedToday: 10 },
      ),
    );

    expect(result.decision).toBe(PolicyDecisionType.BLOCK);
    expect(result.blockers.map((b) => b.ruleId)).toContain('policy.limits.daily_cap_reached');
  });

  it('escalates to human review as the cap approaches', () => {
    const result = evaluatePolicy(
      contextFor(
        ActionType.UPDATE_DESCRIPTION,
        {
          description: 'A neighbourhood dental practice providing preventive and restorative care.',
          sourceRef: aiSource,
        },
        { changesAppliedToday: 8 },
      ),
    );

    expect(result.decision).toBe(PolicyDecisionType.REQUIRE_HUMAN);
  });
});

describe('risk assessment', () => {
  it('rates identity-critical actions HIGH', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_TITLE, {
        title: 'Northside Family Dentistry',
        sourceRef: humanSource,
      }),
    );
    expect(result.riskLevel).toBe(RiskLevel.HIGH);
  });

  it('escalates a description change that deletes most of the existing text', () => {
    const gentle = evaluatePolicy(
      contextFor(ActionType.UPDATE_DESCRIPTION, {
        description:
          'A family dental practice offering routine cleanings, restorative work and emergency ' +
          'appointments, with evening availability on request and parking available on site nearby.',
        sourceRef: aiSource,
      }),
    );

    const drastic = evaluatePolicy(
      contextFor(ActionType.UPDATE_DESCRIPTION, {
        description: 'Dental care.',
        sourceRef: aiSource,
      }),
    );

    expect(drastic.riskLevel).not.toBe(gentle.riskLevel);
    expect(drastic.riskLevel).toBe(RiskLevel.HIGH);
  });

  it('escalates hours changes that remove currently-open days', () => {
    const result = evaluatePolicy(
      contextFor(ActionType.UPDATE_REGULAR_HOURS, {
        // healthyLocation is open Monday-Friday; this keeps only Monday.
        periods: [
          {
            openDay: 'MONDAY',
            openTime: { hours: 9, minutes: 0 },
            closeDay: 'MONDAY',
            closeTime: { hours: 17, minutes: 0 },
          },
        ],
        sourceRef: humanSource,
      }),
    );

    expect(result.riskLevel).toBe(RiskLevel.HIGH);
  });
});

describe('structural invariants', () => {
  it('has no action type that solicits or authors reviews', () => {
    // Review gating and fake reviews are not "blocked at runtime" — they are
    // unrepresentable. There is no action a caller could name to request them.
    const actionNames = Object.values(ActionType).map((a) => a.toLowerCase());

    for (const forbidden of ['request_review', 'solicit', 'create_review', 'write_review']) {
      expect(actionNames.some((name) => name.includes(forbidden))).toBe(false);
    }
  });

  it('only exposes review actions that respond as the owner', () => {
    const reviewActions = Object.values(ActionType).filter((a) =>
      a.toLowerCase().includes('review'),
    );
    // Replying to, editing a reply to, or deleting a reply — never authoring one.
    for (const action of reviewActions) {
      expect(action).toMatch(/REPLY/);
    }
  });
});
