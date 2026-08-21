/**
 * Separation of duties.
 *
 * The rule is absolute by design, so the tests that matter most are the ones
 * asserting there is no way around it — including for a single-operator
 * organization, which is exactly the case an exemption would have been built
 * for.
 */

import { describe, it, expect } from 'vitest';
import { assertSeparationOfDuties, canApprove } from '@/server/policy/separation-of-duties';
import { ForbiddenError } from '@/server/errors';

describe('assertSeparationOfDuties', () => {
  it('refuses the proposer approving their own change', () => {
    expect(() =>
      assertSeparationOfDuties({ requestedByUserId: 'user_a' }, { userId: 'user_a' }),
    ).toThrowError(ForbiddenError);
  });

  it('allows a different person to approve', () => {
    expect(() =>
      assertSeparationOfDuties({ requestedByUserId: 'user_a' }, { userId: 'user_b' }),
    ).not.toThrow();
  });

  it('allows any authorized human to approve a system-generated proposal', () => {
    // Nobody proposed it, so the approver IS the second pair of eyes.
    expect(() =>
      assertSeparationOfDuties({ requestedByUserId: null }, { userId: 'user_a' }),
    ).not.toThrow();
  });

  it('explains what to do instead of just refusing', () => {
    try {
      assertSeparationOfDuties({ requestedByUserId: 'user_a' }, { userId: 'user_a' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as ForbiddenError).message;
      expect(message).toMatch(/cannot approve it/i);
      // A refusal with no remedy is a dead end for a solo operator.
      expect(message).toMatch(/invite another/i);
    }
  });

  it('surfaces the reason for the audit trail', () => {
    try {
      assertSeparationOfDuties({ requestedByUserId: 'user_a' }, { userId: 'user_a' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ForbiddenError).context).toMatchObject({
        reason: 'separation_of_duties',
      });
    }
  });
});

describe('no exemption exists', () => {
  /**
   * These pin the decision itself rather than its implementation. If someone
   * later adds a "solo operator" or "small team" bypass, the rule has to change
   * shape enough to break these — which is the point.
   */
  it('has no argument that could relax the rule', () => {
    // The function takes exactly two arguments: the request and the approver.
    // No options object, no org, no plan tier — nowhere to thread an exemption.
    expect(assertSeparationOfDuties.length).toBe(2);
  });

  it('refuses identically regardless of how many times it is asked', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(() =>
        assertSeparationOfDuties({ requestedByUserId: 'solo' }, { userId: 'solo' }),
      ).toThrowError(ForbiddenError);
    }
  });

  it('is not satisfied by an empty or whitespace user id collision', () => {
    // Guards against a context with a missing user id accidentally passing.
    expect(() => assertSeparationOfDuties({ requestedByUserId: '' }, { userId: '' })).toThrowError(
      ForbiddenError,
    );
  });
});

describe('canApprove (UI predicate)', () => {
  it('agrees with the assertion in both directions', () => {
    const own = { requestedByUserId: 'user_a' };
    const other = { requestedByUserId: 'user_b' };

    expect(canApprove(own, { userId: 'user_a' })).toBe(false);
    expect(canApprove(other, { userId: 'user_a' })).toBe(true);

    // Whatever the predicate permits, the assertion must also permit.
    expect(() => assertSeparationOfDuties(other, { userId: 'user_a' })).not.toThrow();
    expect(() => assertSeparationOfDuties(own, { userId: 'user_a' })).toThrow();
  });

  it('permits approving a system proposal', () => {
    expect(canApprove({ requestedByUserId: null }, { userId: 'user_a' })).toBe(true);
  });
});
