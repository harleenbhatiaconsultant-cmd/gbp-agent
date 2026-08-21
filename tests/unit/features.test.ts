/**
 * Write-safety defaults.
 *
 * These assertions exist because the two values they cover are the difference
 * between "rehearsing against Google" and "silently editing a real customer's
 * business listing". If someone changes a default, this file should be the
 * thing that stops them.
 */

import { describe, it, expect } from 'vitest';
import { ActionType, RiskLevel } from '@/generated/prisma/enums';
import {
  canAutoApply,
  getWriteMode,
  isDryRun,
  assertLiveWritesAllowed,
  ALWAYS_HUMAN_APPROVED_ACTIONS,
  BASELINE_ACTION_RISK,
} from '@/config/features';

describe('GBP write mode', () => {
  it('defaults to validate_only', () => {
    expect(getWriteMode()).toBe('validate_only');
  });

  it('reports dry-run so executors send validateOnly=true', () => {
    expect(isDryRun()).toBe(true);
  });

  it('refuses a live write while in validate_only', () => {
    expect(() => assertLiveWritesAllowed('test')).toThrowError(/Refusing live write/);
  });
});

describe('auto-apply', () => {
  const lowRiskOptedIn = {
    actionType: ActionType.UPDATE_LABELS,
    riskLevel: RiskLevel.LOW,
    organizationAutoApplyActions: [ActionType.UPDATE_LABELS],
  };

  it('is refused platform-wide by default', () => {
    const decision = canAutoApply(lowRiskOptedIn);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/disabled platform-wide/);
  });

  it('refuses when the organization has not opted in', () => {
    const decision = canAutoApply({
      actionType: ActionType.UPDATE_LABELS,
      riskLevel: RiskLevel.LOW,
      organizationAutoApplyActions: [],
    });
    expect(decision.allowed).toBe(false);
  });

  it('refuses non-LOW risk regardless of opt-in', () => {
    const decision = canAutoApply({
      actionType: ActionType.UPDATE_DESCRIPTION,
      riskLevel: RiskLevel.MEDIUM,
      organizationAutoApplyActions: [ActionType.UPDATE_DESCRIPTION],
    });
    expect(decision.allowed).toBe(false);
  });

  it('never auto-applies a business name change', () => {
    const decision = canAutoApply({
      actionType: ActionType.UPDATE_TITLE,
      riskLevel: RiskLevel.LOW, // even if something mislabels the risk
      organizationAutoApplyActions: [ActionType.UPDATE_TITLE],
    });
    expect(decision.allowed).toBe(false);
  });

  it('never auto-applies a category change', () => {
    const decision = canAutoApply({
      actionType: ActionType.UPDATE_CATEGORIES,
      riskLevel: RiskLevel.LOW,
      organizationAutoApplyActions: [ActionType.UPDATE_CATEGORIES],
    });
    expect(decision.allowed).toBe(false);
  });

  it('treats a missing organization allowlist as "nothing opted in"', () => {
    expect(canAutoApply({ ...lowRiskOptedIn, organizationAutoApplyActions: null }).allowed).toBe(
      false,
    );
  });
});

describe('risk classification', () => {
  it('classifies identity-critical fields as HIGH risk', () => {
    expect(BASELINE_ACTION_RISK[ActionType.UPDATE_TITLE]).toBe(RiskLevel.HIGH);
    expect(BASELINE_ACTION_RISK[ActionType.UPDATE_CATEGORIES]).toBe(RiskLevel.HIGH);
    expect(BASELINE_ACTION_RISK[ActionType.UPDATE_ADDRESS]).toBe(RiskLevel.HIGH);
  });

  it('assigns every action type a baseline risk', () => {
    for (const action of Object.values(ActionType)) {
      expect(BASELINE_ACTION_RISK[action]).toBeDefined();
    }
  });

  it('keeps destructive actions on the always-human list', () => {
    expect(ALWAYS_HUMAN_APPROVED_ACTIONS.has(ActionType.DELETE_MEDIA)).toBe(true);
    expect(ALWAYS_HUMAN_APPROVED_ACTIONS.has(ActionType.DELETE_REVIEW_REPLY)).toBe(true);
  });
});

/**
 * Settled decisions, pinned so they break the build rather than slipping
 * through review. These are not "current defaults" — removing an entry here is
 * a decision to be argued explicitly, which is the point of failing loudly.
 */
describe('permanently human-approved actions', () => {
  it('never lets a category change be automated', () => {
    // The primary category is the strongest single ranking signal a profile
    // has, and a wrong one is the most damaging non-fatal error available.
    // The blast radius does not justify automating it, however confident a
    // proposal looks.
    expect(ALWAYS_HUMAN_APPROVED_ACTIONS.has(ActionType.UPDATE_CATEGORIES)).toBe(true);
  });

  it('never lets an address change be automated', () => {
    // A bad address write frequently triggers Google re-verification, which
    // can take a profile offline entirely.
    expect(ALWAYS_HUMAN_APPROVED_ACTIONS.has(ActionType.UPDATE_ADDRESS)).toBe(true);
  });

  it('never lets a business name change be automated', () => {
    expect(ALWAYS_HUMAN_APPROVED_ACTIONS.has(ActionType.UPDATE_TITLE)).toBe(true);
  });

  it('refuses them even when the org opts in and risk is mislabelled LOW', () => {
    for (const action of [
      ActionType.UPDATE_CATEGORIES,
      ActionType.UPDATE_ADDRESS,
      ActionType.UPDATE_TITLE,
    ]) {
      const decision = canAutoApply({
        actionType: action,
        riskLevel: RiskLevel.LOW,
        organizationAutoApplyActions: [action],
      });
      expect(decision.allowed, `${action} must never auto-apply`).toBe(false);
    }
    // NOTE: with ENABLE_AUTO_APPLY false these are refused by the global flag
    // before the always-human list is consulted, so this alone would pass even
    // if the list were empty. always-human-actions.test.ts turns the flag ON
    // and asserts the list is what refuses them.
  });
});
