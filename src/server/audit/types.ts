/**
 * The audit rule contract.
 *
 * Rules are PURE FUNCTIONS of a snapshot. No database, no network, no clock
 * beyond what the context supplies. That is what makes an audit reproducible
 * months later and unit-testable against fixtures — and it is enforced by the
 * lint zone on src/server/audit/rules in eslint.config.mjs.
 *
 * A rule returns one of three outcomes, and the distinction matters:
 *   pass    — the check ran and the profile is fine
 *   fail    — the check ran and found something, with evidence
 *   skipped — the check could not run because required data is not connected
 *
 * `skipped` is not `pass`. Skipped rules are excluded from both sides of the
 * score, and reported as coverage, so a profile cannot appear healthy merely
 * because half the checks never ran.
 */

import type { ActionType, AuditScope, FindingSeverity } from '@/generated/prisma/enums';
import type { GbpLocationResource } from '@/server/integrations/google/types';

export const RULESET_VERSION = 'v1.0.0';

export type AuditCategory =
  | 'profile_completeness'
  | 'categories'
  | 'contact'
  | 'hours'
  | 'content'
  | 'reviews'
  | 'website';

/** What a rule needs in order to run at all. */
export type DataRequirement = 'profile' | 'reviews' | 'media' | 'website';

export interface ReviewSummary {
  totalCount: number;
  averageRating: number;
  /** Reviews with no owner reply. */
  unansweredCount: number;
  newestReviewAt: Date | null;
  newestOwnerReplyAt: Date | null;
}

export interface RuleContext {
  /** Exactly what Google returned, from an immutable LocationSnapshot. */
  readonly profile: GbpLocationResource;
  /** Injected rather than read from the clock, so results are reproducible. */
  readonly evaluatedAt: Date;
  /** Absent until the reviews sync exists; review rules skip without it. */
  readonly reviews?: ReviewSummary;
  /** Absent until the website crawler exists. */
  readonly website?: { rootUrl: string };
}

export interface FindingDraft {
  severity: FindingSeverity;
  title: string;
  detail: string;
  /** Structured facts backing the finding. Shown to the client verbatim. */
  evidence?: Record<string, unknown>;
  /** Whether this could be fixed through the API, once writes are enabled. */
  autoFixable: boolean;
  suggestedActionType?: ActionType;
  /**
   * Distinguishes multiple findings from one rule (e.g. per weekday).
   * Combined with the rule id to form the stable fingerprint.
   */
  discriminator?: string;
}

export type RuleOutcome =
  | { status: 'pass' }
  | { status: 'fail'; findings: FindingDraft[] }
  | { status: 'skipped'; reason: string };

export interface RuleDefinition {
  readonly id: string;
  readonly category: AuditCategory;
  readonly scope: AuditScope;
  /** Human-readable name of what is being checked. */
  readonly title: string;
  /** Points this rule contributes to the health score when it runs. */
  readonly weight: number;
  readonly requires: readonly DataRequirement[];
  evaluate(ctx: RuleContext): RuleOutcome;
}

export const pass = (): RuleOutcome => ({ status: 'pass' });
export const skip = (reason: string): RuleOutcome => ({ status: 'skipped', reason });
export const fail = (...findings: FindingDraft[]): RuleOutcome => ({
  status: 'fail',
  findings,
});
