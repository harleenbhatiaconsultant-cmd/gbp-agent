/**
 * Feature flags and write-safety gates.
 *
 * This module is the single place that decides whether the platform is allowed
 * to mutate a real Google Business Profile, and whether it may do so without a
 * human approving first. Executors must consult it — they must not read
 * `env.GBP_WRITE_MODE` or `env.ENABLE_AUTO_APPLY` directly.
 *
 * Two independent safety properties are enforced here:
 *
 *   1. WRITE MODE defaults to `validate_only`. Every Google write is sent with
 *      validateOnly=true and mutates nothing. Google provides no sandbox, so
 *      this is the only safe rehearsal available.
 *
 *   2. AUTO-APPLY defaults to OFF, and requires THREE independent conditions
 *      to be true before an approved change may execute without a human:
 *        a. the global ENABLE_AUTO_APPLY flag,
 *        b. the organization explicitly opting that action type in,
 *        c. the action not being classified as high-risk.
 *      Any one of them being false means a human must approve.
 */

import { ActionType, RiskLevel } from '@/generated/prisma/enums';
import { env } from '@/config/env.server';

// ---------------------------------------------------------------------------
// Write mode
// ---------------------------------------------------------------------------

export type WriteMode = 'validate_only' | 'live';

/** The effective write mode. Defaults to `validate_only`. */
export function getWriteMode(): WriteMode {
  return env.GBP_WRITE_MODE;
}

/**
 * True when Google writes must carry validateOnly=true.
 * Defaults to true; only an explicit production `GBP_WRITE_MODE=live` turns it off.
 */
export function isDryRun(): boolean {
  return getWriteMode() !== 'live';
}

/**
 * Throws unless the process is configured for real, irreversible writes.
 * Call immediately before any live mutation as a last-line assertion.
 */
export function assertLiveWritesAllowed(context: string): void {
  if (isDryRun()) {
    throw new Error(
      `Refusing live write (${context}): GBP_WRITE_MODE is "${getWriteMode()}". ` +
        'Live writes require GBP_WRITE_MODE=live with NODE_ENV=production.',
    );
  }
}

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

/**
 * Actions that ALWAYS require a named human approver, regardless of any flag,
 * plan, or organization setting.
 *
 * Business name and category are here because they are the two fields most
 * likely to trigger a Google suspension or destroy ranking if set wrongly, and
 * because name manipulation is an explicit Google policy violation
 * (see ARCHITECTURE.md §7).
 *
 * PERMANENT ENTRIES — settled decisions, not current-state defaults:
 *
 *   UPDATE_CATEGORIES is permanently on this list. The primary category is the
 *   strongest single ranking signal a profile has and a wrong one is the most
 *   damaging non-fatal error available, so the blast radius does not justify
 *   automating it however confident the proposal looks. This is not "off until
 *   we trust it" — removing it is a decision to be argued explicitly, not made
 *   in passing while enabling auto-apply for something else.
 *
 *   UPDATE_ADDRESS is permanently on this list for the same reason: a bad
 *   address write frequently triggers Google re-verification, which can take a
 *   profile offline entirely.
 *
 * Both are pinned by tests in tests/unit/features.test.ts so removal breaks
 * the build rather than slipping through review.
 */
export const ALWAYS_HUMAN_APPROVED_ACTIONS: ReadonlySet<ActionType> = new Set([
  ActionType.UPDATE_TITLE,
  ActionType.UPDATE_CATEGORIES,
  ActionType.UPDATE_ADDRESS,
  ActionType.UPDATE_PHONE,
  ActionType.UPDATE_WEBSITE,
  ActionType.DELETE_MEDIA,
  ActionType.DELETE_POST,
  ActionType.DELETE_REVIEW_REPLY,
]);

/** Baseline risk for an action type, before the size of the delta is considered. */
export const BASELINE_ACTION_RISK: Readonly<Record<ActionType, RiskLevel>> = {
  [ActionType.UPDATE_TITLE]: RiskLevel.HIGH,
  [ActionType.UPDATE_CATEGORIES]: RiskLevel.HIGH,
  [ActionType.UPDATE_ADDRESS]: RiskLevel.HIGH,
  [ActionType.UPDATE_PHONE]: RiskLevel.HIGH,
  [ActionType.UPDATE_WEBSITE]: RiskLevel.HIGH,
  [ActionType.UPDATE_SERVICE_AREA]: RiskLevel.MEDIUM,
  [ActionType.UPDATE_DESCRIPTION]: RiskLevel.MEDIUM,
  [ActionType.UPDATE_REGULAR_HOURS]: RiskLevel.MEDIUM,
  [ActionType.UPDATE_SPECIAL_HOURS]: RiskLevel.LOW,
  [ActionType.UPDATE_ATTRIBUTES]: RiskLevel.LOW,
  [ActionType.UPDATE_LABELS]: RiskLevel.LOW,
  [ActionType.UPDATE_OPENING_DATE]: RiskLevel.MEDIUM,
  [ActionType.CREATE_POST]: RiskLevel.LOW,
  [ActionType.DELETE_POST]: RiskLevel.MEDIUM,
  [ActionType.REPLY_TO_REVIEW]: RiskLevel.MEDIUM,
  [ActionType.UPDATE_REVIEW_REPLY]: RiskLevel.MEDIUM,
  [ActionType.DELETE_REVIEW_REPLY]: RiskLevel.HIGH,
  [ActionType.UPLOAD_MEDIA]: RiskLevel.LOW,
  [ActionType.DELETE_MEDIA]: RiskLevel.HIGH,
};

// ---------------------------------------------------------------------------
// Auto-apply decision
// ---------------------------------------------------------------------------

export interface AutoApplyInput {
  actionType: ActionType;
  riskLevel: RiskLevel;
  /**
   * The organization's `settings.autoApply` allowlist: action types the customer
   * has explicitly opted into. Absent or empty means "nothing is auto-applied",
   * which is the default for every new organization.
   */
  organizationAutoApplyActions?: readonly ActionType[] | null;
}

export interface AutoApplyDecision {
  allowed: boolean;
  /** Human-readable reason, recorded on the ChangeRequest for the audit trail. */
  reason: string;
}

/**
 * Decides whether an approved change may execute without a human approver.
 *
 * Defaults to `false`. Every branch that returns `true` must have passed all
 * three independent conditions.
 */
export function canAutoApply(input: AutoApplyInput): AutoApplyDecision {
  if (!env.ENABLE_AUTO_APPLY) {
    return {
      allowed: false,
      reason: 'Auto-apply is disabled platform-wide (ENABLE_AUTO_APPLY=false).',
    };
  }

  if (ALWAYS_HUMAN_APPROVED_ACTIONS.has(input.actionType)) {
    return {
      allowed: false,
      reason: `Action ${input.actionType} always requires a human approver.`,
    };
  }

  if (input.riskLevel !== RiskLevel.LOW) {
    return {
      allowed: false,
      reason: `Risk level ${input.riskLevel} requires a human approver; only LOW-risk changes may auto-apply.`,
    };
  }

  const optedIn = input.organizationAutoApplyActions ?? [];
  if (!optedIn.includes(input.actionType)) {
    return {
      allowed: false,
      reason: `This organization has not opted into auto-applying ${input.actionType}.`,
    };
  }

  return {
    allowed: true,
    reason: `Auto-apply permitted: LOW-risk ${input.actionType}, explicitly opted in by the organization.`,
  };
}

// ---------------------------------------------------------------------------
// Module flags
// ---------------------------------------------------------------------------

export const features = {
  autoApply: env.ENABLE_AUTO_APPLY,
  posts: env.ENABLE_POSTS,
  rankTracking: env.ENABLE_RANK_TRACKING,
  competitors: env.ENABLE_COMPETITORS,
  websiteAudit: env.ENABLE_WEBSITE_AUDIT,
  reports: env.ENABLE_REPORTS,
  whiteLabel: env.ENABLE_WHITE_LABEL,
  billing: env.ENABLE_BILLING,
} as const;

export type FeatureName = keyof typeof features;

export function isFeatureEnabled(name: FeatureName): boolean {
  return features[name];
}
