/**
 * Payload schemas for every mutation the platform can perform.
 *
 * These are the narrow gate between "something proposed a change" and "a change
 * exists". Nothing reaches an executor without parsing cleanly here first —
 * including anything an LLM produced, which is why the AI is only ever asked
 * for an object matching one of these shapes and never for an action to take.
 *
 * SOURCE ATTRIBUTION IS MANDATORY. Every payload carries a `sourceRef` naming
 * where the value came from. A model cannot invent a phone number, an address
 * or opening hours and have it accepted: without a source the fabrication
 * guard blocks the change outright (see src/server/policy).
 */

import { z } from 'zod';
import { ActionType } from '@/generated/prisma/enums';

/**
 * Where a proposed value came from.
 *
 * `AI_GENERATED` is deliberately absent for factual fields — a model may draft
 * prose (a description) but may never be the source of a fact such as a phone
 * number. The fabrication guard enforces that split by action type.
 */
export const sourceRefSchema = z.object({
  kind: z.enum([
    /** A human typed it into the platform. */
    'USER_INPUT',
    /** Read from the connected website. */
    'WEBSITE',
    /** Already present on the Google profile; a reformat or move. */
    'GBP_CURRENT',
    /** A document the customer supplied. */
    'DOCUMENT',
    /** Model-authored prose. Permitted only for narrative fields. */
    'AI_GENERATED',
  ]),
  detail: z.string().min(1, 'Describe where this value came from').max(500),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

const baseFields = { sourceRef: sourceRefSchema };

// ---------------------------------------------------------------------------
// Identity and classification
// ---------------------------------------------------------------------------

export const updateTitleSchema = z.object({
  ...baseFields,
  title: z.string().trim().min(1).max(300),
});

const categoryIdSchema = z
  .string()
  .trim()
  .regex(/^gcid:[a-z0-9_]+$/, 'Must be a Google category id such as "gcid:dentist"');

export const updateCategoriesSchema = z.object({
  ...baseFields,
  primaryCategoryId: categoryIdSchema,
  primaryCategoryName: z.string().trim().max(200).optional(),
  // Google caps additional categories at 9.
  additionalCategoryIds: z.array(categoryIdSchema).max(9).default([]),
});

// ---------------------------------------------------------------------------
// Narrative content
// ---------------------------------------------------------------------------

export const updateDescriptionSchema = z.object({
  ...baseFields,
  description: z.string().trim().min(1).max(750, 'Google allows at most 750 characters'),
});

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

export const updatePhoneSchema = z.object({
  ...baseFields,
  primaryPhone: z.string().trim().min(5).max(30),
  additionalPhones: z.array(z.string().trim().min(5).max(30)).max(2).default([]),
});

export const updateWebsiteSchema = z.object({
  ...baseFields,
  websiteUri: z.url('Must be a valid URL').max(500),
});

export const updateAddressSchema = z.object({
  ...baseFields,
  regionCode: z.string().trim().length(2, 'Two-letter country code'),
  languageCode: z.string().trim().max(10).optional(),
  postalCode: z.string().trim().max(20).optional(),
  administrativeArea: z.string().trim().max(120).optional(),
  locality: z.string().trim().max(120).optional(),
  addressLines: z.array(z.string().trim().min(1).max(200)).min(1).max(5),
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const dayOfWeekSchema = z.enum([
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
]);

/**
 * A time of day, matching Google's TimeOfDay.
 *
 * `hours` allows 24, not 23: Google represents "open until end of day" — and
 * therefore a 24-hour business — as a close time of 24:00. Capping at 23 would
 * make it impossible to describe a business that never closes. 24 is only valid
 * on the hour, so 24:30 is rejected.
 */
const timeOfDaySchema = z
  .object({
    hours: z.number().int().min(0).max(24),
    minutes: z.number().int().min(0).max(59).default(0),
  })
  .refine((time) => time.hours !== 24 || time.minutes === 0, {
    message: '24:00 is the end of the day; minutes must be 0 when hours is 24',
  });

export const updateRegularHoursSchema = z.object({
  ...baseFields,
  periods: z
    .array(
      z.object({
        openDay: dayOfWeekSchema,
        openTime: timeOfDaySchema,
        closeDay: dayOfWeekSchema,
        closeTime: timeOfDaySchema,
      }),
    )
    .max(50),
});

export const updateSpecialHoursSchema = z.object({
  ...baseFields,
  periods: z
    .array(
      z.object({
        startDate: z.object({
          year: z.number().int().min(2000).max(2100),
          month: z.number().int().min(1).max(12),
          day: z.number().int().min(1).max(31),
        }),
        closed: z.boolean().default(false),
        openTime: timeOfDaySchema.optional(),
        closeTime: timeOfDaySchema.optional(),
      }),
    )
    .max(60),
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Action types with a working executor.
 *
 * Everything else in the ActionType enum is declared for schema stability but
 * has no implementation yet, and the registry refuses it explicitly rather than
 * failing somewhere deeper. Posts, review replies and media all live on the
 * legacy v4 API and belong to their own phases.
 */
export const ACTION_PAYLOAD_SCHEMAS = {
  [ActionType.UPDATE_TITLE]: updateTitleSchema,
  [ActionType.UPDATE_CATEGORIES]: updateCategoriesSchema,
  [ActionType.UPDATE_DESCRIPTION]: updateDescriptionSchema,
  [ActionType.UPDATE_PHONE]: updatePhoneSchema,
  [ActionType.UPDATE_WEBSITE]: updateWebsiteSchema,
  [ActionType.UPDATE_ADDRESS]: updateAddressSchema,
  [ActionType.UPDATE_REGULAR_HOURS]: updateRegularHoursSchema,
  [ActionType.UPDATE_SPECIAL_HOURS]: updateSpecialHoursSchema,
} as const;

export type ImplementedActionType = keyof typeof ACTION_PAYLOAD_SCHEMAS;

export function isImplementedActionType(
  actionType: ActionType,
): actionType is ImplementedActionType {
  return actionType in ACTION_PAYLOAD_SCHEMAS;
}

export type ActionPayload<T extends ImplementedActionType> = z.infer<
  (typeof ACTION_PAYLOAD_SCHEMAS)[T]
>;

/**
 * Text-bearing fields per action, for the content guardrails to scan.
 * Anything listed here is checked for ranking claims and keyword stuffing.
 */
export const ACTION_TEXT_FIELDS: Partial<Record<ActionType, readonly string[]>> = {
  [ActionType.UPDATE_TITLE]: ['title'],
  [ActionType.UPDATE_DESCRIPTION]: ['description'],
  [ActionType.UPDATE_CATEGORIES]: ['primaryCategoryName'],
};

/**
 * Actions whose value is a FACT about the business rather than prose.
 * A model may not be the source of these — see the fabrication guard.
 */
export const FACTUAL_ACTIONS: ReadonlySet<ActionType> = new Set([
  ActionType.UPDATE_TITLE,
  ActionType.UPDATE_PHONE,
  ActionType.UPDATE_WEBSITE,
  ActionType.UPDATE_ADDRESS,
  ActionType.UPDATE_REGULAR_HOURS,
  ActionType.UPDATE_SPECIAL_HOURS,
  ActionType.UPDATE_CATEGORIES,
]);
