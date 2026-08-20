/**
 * Executor tests.
 *
 * The property that matters most here is patch/mask agreement. Google replaces
 * exactly the fields named in `updateMask` — so a mask naming a field the patch
 * does not set will ERASE that field on a live profile. Every executor is
 * checked for that, generically, so a new one cannot be added without it.
 */

import { describe, it, expect } from 'vitest';
import { ActionType } from '@/generated/prisma/enums';
import { getExecutor, hasExecutor, IMPLEMENTED_ACTIONS } from '@/server/actions/registry';
import { ACTION_PAYLOAD_SCHEMAS } from '@/schemas/actions';
import { healthyLocation, neglectedLocation } from '../fixtures/locations';

const humanSource = { kind: 'USER_INPUT' as const, detail: 'Confirmed with the owner' };

/** A minimal valid payload per implemented action. */
const SAMPLE_PAYLOADS: Record<string, Record<string, unknown>> = {
  [ActionType.UPDATE_TITLE]: { title: 'Northside Dental', sourceRef: humanSource },
  [ActionType.UPDATE_CATEGORIES]: {
    primaryCategoryId: 'gcid:dentist',
    additionalCategoryIds: ['gcid:dental_clinic'],
    sourceRef: humanSource,
  },
  [ActionType.UPDATE_DESCRIPTION]: {
    description: 'A neighbourhood dental practice offering preventive and restorative care.',
    sourceRef: { kind: 'AI_GENERATED' as const, detail: 'Drafted by the assistant' },
  },
  [ActionType.UPDATE_PHONE]: {
    primaryPhone: '+1 555-0100',
    additionalPhones: [],
    sourceRef: humanSource,
  },
  [ActionType.UPDATE_WEBSITE]: {
    websiteUri: 'https://example.com/portland',
    sourceRef: humanSource,
  },
  [ActionType.UPDATE_ADDRESS]: {
    regionCode: 'US',
    addressLines: ['1200 NW 23rd Ave'],
    locality: 'Portland',
    administrativeArea: 'OR',
    sourceRef: humanSource,
  },
  [ActionType.UPDATE_REGULAR_HOURS]: {
    periods: [
      {
        openDay: 'MONDAY',
        openTime: { hours: 9, minutes: 0 },
        closeDay: 'MONDAY',
        closeTime: { hours: 17, minutes: 0 },
      },
    ],
    sourceRef: humanSource,
  },
  [ActionType.UPDATE_SPECIAL_HOURS]: {
    periods: [{ startDate: { year: 2030, month: 12, day: 25 }, closed: true }],
    sourceRef: humanSource,
  },
};

describe('registry', () => {
  it('implements every action that has a payload schema', () => {
    for (const actionType of Object.keys(ACTION_PAYLOAD_SCHEMAS)) {
      expect(hasExecutor(actionType as ActionType)).toBe(true);
    }
  });

  it('refuses an action with no executor, naming the phase it belongs to', () => {
    // Posts and review replies live on the legacy v4 API and are later phases.
    expect(() => getExecutor(ActionType.CREATE_POST)).toThrowError(/legacy/i);
    expect(() => getExecutor(ActionType.REPLY_TO_REVIEW)).toThrowError(/No executor/);
  });

  it('does not silently implement destructive actions', () => {
    for (const destructive of [
      ActionType.DELETE_MEDIA,
      ActionType.DELETE_POST,
      ActionType.DELETE_REVIEW_REPLY,
    ]) {
      expect(hasExecutor(destructive)).toBe(false);
    }
  });
});

describe('patch and updateMask agreement', () => {
  it.each(IMPLEMENTED_ACTIONS)(
    '%s builds a mask that matches the fields it actually sets',
    (actionType) => {
      const executor = getExecutor(actionType);
      const payload = executor.schema.parse(SAMPLE_PAYLOADS[actionType]);
      const { patch, updateMask } = executor.buildPatch(payload);

      expect(updateMask.length).toBeGreaterThan(0);

      // Every masked path must resolve to something actually present in the
      // patch. A mask naming an unset field erases it on a live profile.
      for (const path of updateMask) {
        const root = path.split('.')[0];
        expect(Object.keys(patch)).toContain(root);
      }

      // And nothing may be patched that the mask does not cover, or Google
      // silently ignores it and the change appears to succeed while doing nothing.
      for (const key of Object.keys(patch)) {
        expect(updateMask.some((path) => path.split('.')[0] === key)).toBe(true);
      }
    },
  );

  it.each(IMPLEMENTED_ACTIONS)('%s captures the prior value for the change log', (actionType) => {
    const executor = getExecutor(actionType);
    const before = executor.captureBefore(healthyLocation);
    expect(Object.keys(before).length).toBeGreaterThan(0);
  });

  it.each(IMPLEMENTED_ACTIONS)('%s describes itself in plain language', (actionType) => {
    const executor = getExecutor(actionType);
    const payload = executor.schema.parse(SAMPLE_PAYLOADS[actionType]);
    const summary = executor.describe(payload, healthyLocation);

    expect(summary.length).toBeGreaterThan(10);
    // The change log is client-facing; it should not leak identifiers.
    expect(summary).not.toContain('undefined');
  });

  it('handles a profile with nothing set without throwing', () => {
    for (const actionType of IMPLEMENTED_ACTIONS) {
      const executor = getExecutor(actionType);
      expect(() => executor.captureBefore(neglectedLocation)).not.toThrow();
    }
  });
});

describe('payload validation', () => {
  it('rejects a description over the Google limit', () => {
    const executor = getExecutor(ActionType.UPDATE_DESCRIPTION);
    const result = executor.schema.safeParse({
      description: 'x'.repeat(751),
      sourceRef: humanSource,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed category id', () => {
    const executor = getExecutor(ActionType.UPDATE_CATEGORIES);
    const result = executor.schema.safeParse({
      primaryCategoryId: 'dentist',
      additionalCategoryIds: [],
      sourceRef: humanSource,
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than nine secondary categories', () => {
    const executor = getExecutor(ActionType.UPDATE_CATEGORIES);
    const result = executor.schema.safeParse({
      primaryCategoryId: 'gcid:dentist',
      additionalCategoryIds: Array.from({ length: 10 }, (_, i) => `gcid:cat_${i}`),
      sourceRef: humanSource,
    });
    expect(result.success).toBe(false);
  });

  it('requires a source reference on every payload', () => {
    for (const actionType of IMPLEMENTED_ACTIONS) {
      const executor = getExecutor(actionType);
      const { sourceRef: _omitted, ...withoutSource } = SAMPLE_PAYLOADS[actionType];
      void _omitted;
      expect(executor.schema.safeParse(withoutSource).success).toBe(false);
    }
  });
});
