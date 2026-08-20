import { FindingSeverity, PolicyDecisionType } from '@/generated/prisma/enums';
import { ACTION_TEXT_FIELDS } from '@/schemas/actions';
import { tokenize, type Guardrail, type GuardrailFinding } from '@/server/policy/types';

/**
 * Repeating a term to chase relevance degrades the profile for readers and is
 * treated as spam by Google.
 *
 * Two signals, because they catch different abuses:
 *   - repetition: one term used far more often than natural prose would
 *   - density: that term making up a large share of the whole text
 *
 * Short text is exempt: a two-word phrase repeating a word is not stuffing, and
 * flagging it would generate noise that trains people to ignore the guardrail.
 */

const MIN_TOKENS_TO_ASSESS = 12;
const REPEAT_WARN = 4;
const REPEAT_BLOCK = 7;
const DENSITY_WARN = 0.12;
const DENSITY_BLOCK = 0.2;

/** Words that legitimately repeat and should not count toward density. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'at', 'we',
  'our', 'you', 'your', 'is', 'are', 'with', 'from', 'by', 'as', 'that', 'this',
  'it', 'be', 'have', 'has', 'can', 'will', 'all', 'more', 'us', 'their',
]);

export const keywordStuffingGuardrail: Guardrail = {
  id: 'policy.content.keyword_stuffing',
  title: 'Text is not keyword stuffed',

  appliesTo(actionType) {
    return Boolean(ACTION_TEXT_FIELDS[actionType]?.length);
  },

  evaluate(ctx) {
    const fields = ACTION_TEXT_FIELDS[ctx.actionType] ?? [];
    const findings: GuardrailFinding[] = [];

    for (const field of fields) {
      const raw = ctx.payload[field];
      if (typeof raw !== 'string' || !raw) continue;

      const tokens = tokenize(raw).filter((t) => !STOPWORDS.has(t) && t.length > 2);
      if (tokens.length < MIN_TOKENS_TO_ASSESS) continue;

      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

      const [worstToken, worstCount] = [...counts.entries()].reduce(
        (best, entry) => (entry[1] > best[1] ? entry : best),
        ['', 0] as [string, number],
      );

      const density = worstCount / tokens.length;

      if (worstCount >= REPEAT_BLOCK || density >= DENSITY_BLOCK) {
        findings.push({
          ruleId: 'policy.content.keyword_stuffing',
          decision: PolicyDecisionType.BLOCK,
          severity: FindingSeverity.HIGH,
          detail:
            `"${worstToken}" appears ${worstCount} times in "${field}" (${Math.round(density * 100)}% of ` +
            'meaningful words). Google treats this as spam and it reads badly to customers. Rewrite it as ' +
            'plain prose describing the business.',
          evidence: { field, token: worstToken, count: worstCount, density: Number(density.toFixed(3)) },
        });
      } else if (worstCount >= REPEAT_WARN || density >= DENSITY_WARN) {
        findings.push({
          ruleId: 'policy.content.keyword_repetition',
          decision: PolicyDecisionType.REQUIRE_HUMAN,
          severity: FindingSeverity.MEDIUM,
          detail:
            `"${worstToken}" appears ${worstCount} times in "${field}". That is heavier than natural prose. ` +
            'A person should confirm this reads well before it is published.',
          evidence: { field, token: worstToken, count: worstCount, density: Number(density.toFixed(3)) },
        });
      }
    }

    return findings;
  },
};
