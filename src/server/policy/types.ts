/**
 * The compliance guardrail contract.
 *
 * Guardrails run BEFORE anything enters the approval queue, and again on any
 * AI-generated text before it is persisted. Like audit rules they are pure
 * functions — no I/O — so every adversarial case can be tested offline and the
 * reasoning behind a refusal is reproducible.
 *
 * The three decisions are not advisory:
 *   ALLOW         — nothing objectionable found
 *   REQUIRE_HUMAN — may proceed, but only a named person can approve it
 *   BLOCK         — never proceeds, no approval can override it
 *
 * BLOCK is deliberately un-overridable. A customer asking for a blocked change
 * is asking for something that risks their listing being suspended or, for
 * review manipulation, regulatory exposure. The honest answer is refusal plus
 * the compliant alternative.
 */

import type { ActionType, FindingSeverity, PolicyDecisionType, RiskLevel } from '@/generated/prisma/enums';
import type { GbpLocationResource } from '@/server/integrations/google/types';

export interface GuardrailContext {
  readonly actionType: ActionType;
  /** Already parsed against the action's Zod schema. */
  readonly payload: Record<string, unknown>;
  /** The live profile, from the newest snapshot. */
  readonly currentProfile: GbpLocationResource;
  /** Changes already applied to this location today, for blast-radius limits. */
  readonly changesAppliedToday: number;
}

export interface GuardrailFinding {
  readonly ruleId: string;
  readonly decision: PolicyDecisionType;
  readonly severity: FindingSeverity;
  readonly detail: string;
  readonly evidence?: Record<string, unknown>;
}

export interface Guardrail {
  readonly id: string;
  readonly title: string;
  /** Which actions this guardrail inspects. */
  appliesTo(actionType: ActionType): boolean;
  evaluate(ctx: GuardrailContext): GuardrailFinding[];
}

export interface PolicyResult {
  readonly decision: PolicyDecisionType;
  readonly riskLevel: RiskLevel;
  readonly findings: GuardrailFinding[];
  /** Findings that caused a BLOCK. Empty unless decision is BLOCK. */
  readonly blockers: GuardrailFinding[];
}

/** Severity ordering for combining decisions: BLOCK wins, then REQUIRE_HUMAN. */
export function strictest(
  a: PolicyDecisionType,
  b: PolicyDecisionType,
): PolicyDecisionType {
  const rank: Record<PolicyDecisionType, number> = {
    ALLOW: 0,
    REQUIRE_HUMAN: 1,
    BLOCK: 2,
  };
  return rank[a] >= rank[b] ? a : b;
}

/** Normalizes text for comparison: lowercase, punctuation stripped, single-spaced. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(' ') : [];
}
