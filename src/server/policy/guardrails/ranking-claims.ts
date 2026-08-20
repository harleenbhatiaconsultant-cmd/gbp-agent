import { FindingSeverity, PolicyDecisionType } from '@/generated/prisma/enums';
import { ACTION_TEXT_FIELDS } from '@/schemas/actions';
import { normalizeText, type Guardrail, type GuardrailFinding } from '@/server/policy/types';

/**
 * No text this platform publishes may promise a ranking outcome.
 *
 * Local pack position depends on searcher proximity, competitor density and
 * Google's algorithm — none of which any tool controls. A guarantee is both
 * unprovable and, in a commercial context, the fastest route to a dispute.
 *
 * Runs over every outward-facing text field, including anything a model
 * drafted, before it can be stored. Text is normalized first so that spacing
 * and punctuation tricks ("#1", "n u m b e r  1") do not slip through.
 */

/** Word-form claims, matched against punctuation-stripped text. */
const NORMALIZED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bguarantee(d|s)?\b/, label: 'guarantee' },
  { pattern: /\b(number\s*1|no\s*1|number\s+one)\b/, label: 'number one' },
  { pattern: /\btop\s+(of|spot|ranking|result|rated)/, label: 'top ranking' },
  { pattern: /\brank\s+(first|higher|top|1st)/, label: 'rank promise' },
  { pattern: /\bfirst\s+page\b/, label: 'first page' },
  { pattern: /\bpage\s+one\b/, label: 'page one' },
  { pattern: /\bwill\s+(get|put|place)\s+you\s+(on|at|in)\s+(the\s+)?top/, label: 'placement promise' },
  { pattern: /\b100\s*(percent)?\s+(success|results?|ranking)/, label: 'absolute success claim' },
];

/**
 * Symbol-bearing claims, matched against the RAW text.
 *
 * Normalization strips punctuation, which turns "#1" into a bare "1" that
 * cannot be distinguished from "1 hour appointments". These have to be caught
 * before that happens.
 */
const RAW_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /#\s*1\b/, label: 'number one' },
  { pattern: /\bno\.\s*1\b/, label: 'number one' },
  { pattern: /\bnr\.?\s*1\b/, label: 'number one' },
  { pattern: /\b1\s*(st)?\s*(place|spot)\b/, label: 'first place claim' },
];

export const rankingClaimsGuardrail: Guardrail = {
  id: 'policy.content.ranking_claims',
  title: 'No ranking guarantees in published text',

  appliesTo(actionType) {
    return Boolean(ACTION_TEXT_FIELDS[actionType]?.length);
  },

  evaluate(ctx) {
    const fields = ACTION_TEXT_FIELDS[ctx.actionType] ?? [];
    const findings: GuardrailFinding[] = [];

    for (const field of fields) {
      const raw = ctx.payload[field];
      if (typeof raw !== 'string' || !raw) continue;

      const normalized = normalizeText(raw);
      const lowered = raw.toLowerCase();

      const matched = [
        ...NORMALIZED_PATTERNS.filter(({ pattern }) => pattern.test(normalized)),
        ...RAW_PATTERNS.filter(({ pattern }) => pattern.test(lowered)),
      ].map(({ label }) => label);

      if (matched.length > 0) {
        findings.push({
          ruleId: 'policy.content.ranking_claims',
          decision: PolicyDecisionType.BLOCK,
          severity: FindingSeverity.CRITICAL,
          detail:
            `The text in "${field}" contains a ranking claim (${matched.join(', ')}). No tool controls local ` +
            'pack position, so this platform does not publish language promising one. Describe what the ' +
            'business actually does instead.',
          evidence: { field, matched },
        });
      }
    }

    return findings;
  },
};
