import { ActionType, FindingSeverity, PolicyDecisionType } from '@/generated/prisma/enums';
import { tokenize, type Guardrail, type GuardrailFinding } from '@/server/policy/types';

/**
 * Business name manipulation is an explicit Google policy violation and one of
 * the fastest routes to a suspended listing. The profile name must be the name
 * the business actually trades under — not the name plus its services, its
 * city, or a superlative.
 *
 * Two levels of enforcement:
 *   BLOCK         — the proposed name ADDS a service keyword, a location drawn
 *                   from the profile's own address, or marketing language.
 *   REQUIRE_HUMAN — any other rename. The platform never proposes one itself;
 *                   a named person must own it.
 *
 * Removals, reordering, punctuation and casing changes are legitimate cleanups
 * and are deliberately not blocked.
 */

/** Marketing language that has no place in a business name. */
const SUPERLATIVES = [
  'best', 'top', 'number', 'no1', 'cheap', 'cheapest', 'affordable', 'premier',
  'leading', 'trusted', 'official', 'guaranteed', 'fastest', 'nearby', 'near',
  'discount', 'lowest', 'expert', 'experts',
];

/** Generic service words commonly stuffed into names to chase rankings. */
const SERVICE_KEYWORDS = [
  'services', 'service', 'repair', 'cleaning', 'plumber', 'plumbing', 'dentist',
  'dental', 'lawyer', 'attorney', 'roofing', 'hvac', 'electrician', 'contractor',
  'towing', 'locksmith', 'landscaping', 'painter', 'painting', 'mechanic',
  'insurance', 'realtor', 'moving', 'movers', 'salon', 'spa', 'clinic',
];

function locationTokensFromProfile(profile: {
  storefrontAddress?: {
    locality?: string;
    administrativeArea?: string;
    postalCode?: string;
  };
}): Set<string> {
  const address = profile.storefrontAddress;
  const tokens = new Set<string>();
  for (const part of [address?.locality, address?.administrativeArea, address?.postalCode]) {
    if (part) for (const token of tokenize(part)) tokens.add(token);
  }
  return tokens;
}

export const businessNameIntegrityGuardrail: Guardrail = {
  id: 'policy.name.integrity',
  title: 'Business name reflects the real trading name',

  appliesTo(actionType) {
    return actionType === ActionType.UPDATE_TITLE;
  },

  evaluate(ctx) {
    const proposed = String(ctx.payload.title ?? '');
    const current = ctx.currentProfile.title ?? '';

    const currentTokens = new Set(tokenize(current));
    const addedTokens = tokenize(proposed).filter((token) => !currentTokens.has(token));

    const locationTokens = locationTokensFromProfile(ctx.currentProfile);
    const addedLocations = addedTokens.filter((t) => locationTokens.has(t));
    const addedSuperlatives = addedTokens.filter((t) => SUPERLATIVES.includes(t));
    const addedKeywords = addedTokens.filter((t) => SERVICE_KEYWORDS.includes(t));

    const findings: GuardrailFinding[] = [];

    if (addedLocations.length > 0) {
      findings.push({
        ruleId: 'policy.name.location_stuffing',
        decision: PolicyDecisionType.BLOCK,
        severity: FindingSeverity.CRITICAL,
        detail:
          `The proposed name adds location terms (${addedLocations.join(', ')}) that are not part of the ` +
          'business name. Adding a city or region to rank for it violates Google policy on business names ' +
          'and risks suspension. The address field already tells Google where the business is.',
        evidence: { current, proposed, addedLocations },
      });
    }

    if (addedSuperlatives.length > 0) {
      findings.push({
        ruleId: 'policy.name.superlative',
        decision: PolicyDecisionType.BLOCK,
        severity: FindingSeverity.CRITICAL,
        detail:
          `The proposed name adds promotional wording (${addedSuperlatives.join(', ')}). Business names may ` +
          'not contain marketing language under Google policy.',
        evidence: { current, proposed, addedSuperlatives },
      });
    }

    if (addedKeywords.length > 0) {
      findings.push({
        ruleId: 'policy.name.keyword_stuffing',
        decision: PolicyDecisionType.BLOCK,
        severity: FindingSeverity.CRITICAL,
        detail:
          `The proposed name adds service keywords (${addedKeywords.join(', ')}) that are not part of the ` +
          'trading name. Categories and the services list are the correct place to describe what the ' +
          'business does.',
        evidence: { current, proposed, addedKeywords },
      });
    }

    // Any rename surviving the blocks above still needs a person to own it.
    if (findings.length === 0) {
      findings.push({
        ruleId: 'policy.name.requires_human',
        decision: PolicyDecisionType.REQUIRE_HUMAN,
        severity: FindingSeverity.HIGH,
        detail:
          'Business name changes always require a named human approver. A wrong name is among the most ' +
          'damaging profile errors and can trigger re-verification or suspension.',
        evidence: { current, proposed, addedTokens },
      });
    }

    return findings;
  },
};
