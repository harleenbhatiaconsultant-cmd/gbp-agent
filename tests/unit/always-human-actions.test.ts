/**
 * The always-human list, tested with auto-apply TURNED ON.
 *
 * This is the only configuration in which the list does any work. With
 * ENABLE_AUTO_APPLY false — the default, and the setting under which every
 * other test runs — `canAutoApply` refuses everything at the first check, so a
 * test there would pass even if the list were empty. That is a comfortable
 * test, not a useful one.
 *
 * Here the global flag is forced on, so the ONLY thing standing between these
 * actions and an unattended write to a customer's profile is membership of
 * ALWAYS_HUMAN_APPROVED_ACTIONS. If someone removes an entry, this file goes
 * red — which is the entire point of pinning a settled decision in a test.
 */

import { describe, it, expect, vi } from 'vitest';
import { ActionType, RiskLevel } from '@/generated/prisma/enums';

// Force the master switch on for this module only. The application default is
// unchanged, and the env loader still refuses ENABLE_AUTO_APPLY outside
// production — this override exists nowhere but here.
vi.mock('@/config/env.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env.server')>();
  return {
    ...actual,
    env: { ...actual.env, ENABLE_AUTO_APPLY: true },
  };
});

import { canAutoApply, ALWAYS_HUMAN_APPROVED_ACTIONS } from '@/config/features';

/** Settled decisions. Removing one is an argument to be had, not a tidy-up. */
const PERMANENTLY_HUMAN: Array<{ action: ActionType; because: string }> = [
  {
    action: ActionType.UPDATE_CATEGORIES,
    because:
      'the primary category is the strongest single ranking signal, and a wrong one is the ' +
      'most damaging non-fatal error available',
  },
  {
    action: ActionType.UPDATE_ADDRESS,
    because: 'a bad address write triggers re-verification and can take a profile offline',
  },
  {
    action: ActionType.UPDATE_TITLE,
    because: 'name manipulation is an explicit Google policy violation and risks suspension',
  },
];

describe('with auto-apply enabled platform-wide', () => {
  it('confirms the flag really is on, or the rest of this file proves nothing', () => {
    // A LOW-risk, opted-in action that is NOT on the list must now be allowed.
    // If this fails, the mock did not take and every assertion below is vacuous.
    const decision = canAutoApply({
      actionType: ActionType.UPDATE_LABELS,
      riskLevel: RiskLevel.LOW,
      organizationAutoApplyActions: [ActionType.UPDATE_LABELS],
    });
    expect(decision.allowed).toBe(true);
  });

  it.each(PERMANENTLY_HUMAN)(
    'still refuses $action, because $because',
    ({ action }) => {
      const decision = canAutoApply({
        actionType: action,
        riskLevel: RiskLevel.LOW,
        organizationAutoApplyActions: [action],
      });

      expect(decision.allowed).toBe(false);
      // And it is the always-human list doing the refusing, not some other check.
      expect(decision.reason).toMatch(/always requires a human approver/);
    },
  );

  it.each(PERMANENTLY_HUMAN)('keeps $action on the list', ({ action }) => {
    expect(ALWAYS_HUMAN_APPROVED_ACTIONS.has(action)).toBe(true);
  });

  it('refuses them regardless of what risk level the proposal claims', () => {
    for (const { action } of PERMANENTLY_HUMAN) {
      for (const risk of [RiskLevel.LOW, RiskLevel.MEDIUM, RiskLevel.HIGH]) {
        expect(
          canAutoApply({
            actionType: action,
            riskLevel: risk,
            organizationAutoApplyActions: [action],
          }).allowed,
          `${action} at ${risk} risk`,
        ).toBe(false);
      }
    }
  });
});
