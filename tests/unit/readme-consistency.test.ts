/**
 * README structural consistency.
 *
 * The README drifted badly once: its opening paragraph claimed nothing was
 * write-capable while its own status table three screens down said the write
 * path was built. Nobody noticed for several commits, which is the problem with
 * relying on someone noticing.
 *
 * The fix was structural rather than diligence-based — phase status now lives
 * in exactly ONE place, so there is no second copy to fall out of agreement.
 * These tests hold that shape. They deliberately check STRUCTURE, not content:
 * asserting particular phases are "done" would mean editing this file on every
 * status change, which is just the duplication problem again wearing a hat.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');

/** Everything above the first `---`, i.e. the opening summary. */
const summary = readme.split('\n---\n')[0];

const statusSection =
  readme.split('## Status by phase')[1]?.split('\n## ')[0] ?? '';

const tableRows = statusSection
  .split('\n')
  .filter((line) => line.trim().startsWith('|'))
  .filter((line) => !/^\|\s*-+/.test(line.trim()))
  .filter((line) => !/\|\s*Phase\s*\|/.test(line));

describe('the status table', () => {
  it('exists', () => {
    expect(statusSection.trim().length).toBeGreaterThan(0);
  });

  it('has rows', () => {
    expect(tableRows.length).toBeGreaterThan(5);
  });

  it('gives every row a scope and a state', () => {
    for (const row of tableRows) {
      const cells = row
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());

      expect(cells.length, `malformed row: ${row}`).toBe(3);
      const [phase, scope, state] = cells;
      expect(phase.length, `empty phase in: ${row}`).toBeGreaterThan(0);
      expect(scope.length, `empty scope in: ${row}`).toBeGreaterThan(0);
      expect(state.length, `empty state in: ${row}`).toBeGreaterThan(0);
    }
  });

  it('uses a recognised state on every row', () => {
    // Free-text states drift into vagueness. These are the only honest ones:
    // it is done, it is partly done, or it has not started.
    for (const row of tableRows) {
      const state = row.split('|').slice(1, -1)[2].trim().toLowerCase();
      expect(
        /^(done|partial|not started)\b/.test(state),
        `row state must start with done/partial/not started: ${row}`,
      ).toBe(true);
    }
  });
});

describe('the opening summary', () => {
  it('does not enumerate phase numbers', () => {
    // This is the exact shape that drifted: "Phases 0, 1, 2, 3 and 5 complete"
    // in the summary, contradicting the table. Status belongs in one place.
    expect(
      /phases?\s+[\d–—-]/i.test(summary),
      'the summary must not enumerate phases — point at the status table instead',
    ).toBe(false);
  });

  it('does not claim completion in a way the table would have to echo', () => {
    expect(/\b(all phases|everything is (built|done|complete))\b/i.test(summary)).toBe(false);
  });

  it('points the reader at the status table', () => {
    expect(summary).toMatch(/status by phase/i);
  });

  it('still says what is unverified, which is not phase status', () => {
    // Distinct from phase status: "built" and "verified against the real thing"
    // are different claims, and conflating them is how a demo becomes a promise.
    expect(summary).toMatch(/unverified/i);
  });
});

describe('claims that must not reappear', () => {
  it('does not describe the platform as unable to write', () => {
    // True until Phase 6, false since, and it stayed in the README for days.
    expect(/nothing is write-capable/i.test(readme)).toBe(false);
  });

  /**
   * Deliberately NOT tested: whether the README contains ranking-claim
   * language.
   *
   * I tried it and it immediately failed on "No guaranteed ranking claims" —
   * a line that states the policy correctly. A pattern match cannot tell a
   * promise from its disclaimer, and a document that exists partly to explain
   * what the platform refuses to claim will always contain the words it
   * refuses to use.
   *
   * The claims linter belongs where it already is: on AI-generated outward-
   * facing copy, which nobody reviews before it reaches a customer. Human
   * prose in a README is reviewed by humans. Adding the check here would have
   * meant either a stream of false positives or weakening the wording to
   * appease a regex, and the second is worse than the first.
   */
  it('says plainly that ranking is not promised', () => {
    // The positive form is checkable without false positives: the disclaimer
    // has to be present, whatever words surround it.
    expect(readme).toMatch(/no guaranteed ranking claims/i);
  });
});
