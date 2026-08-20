import { ActionType } from '@/generated/prisma/enums';
import { updateCategoriesSchema } from '@/schemas/actions';
import type { ActionExecutor } from '@/server/actions/types';
import type { z } from 'zod';

type Payload = z.infer<typeof updateCategoriesSchema>;

/**
 * Sets the primary and additional categories.
 *
 * The mask covers the whole categories object because primary and additional
 * categories are validated together by Google. Sending only one half under a
 * parent mask would clear the other.
 */
export const updateCategoriesExecutor: ActionExecutor<Payload> = {
  actionType: ActionType.UPDATE_CATEGORIES,
  schema: updateCategoriesSchema,

  buildPatch(payload) {
    return {
      patch: {
        categories: {
          primaryCategory: { name: payload.primaryCategoryId },
          additionalCategories: payload.additionalCategoryIds.map((name) => ({ name })),
        },
      },
      updateMask: ['categories'],
    };
  },

  captureBefore(profile) {
    return {
      primaryCategory: profile.categories?.primaryCategory?.name ?? null,
      primaryCategoryName: profile.categories?.primaryCategory?.displayName ?? null,
      additionalCategories: (profile.categories?.additionalCategories ?? []).map((c) => c.name),
    };
  },

  describe(payload, profile) {
    const before = profile.categories?.primaryCategory?.displayName
      ?? profile.categories?.primaryCategory?.name
      ?? "(none)";
    const after = payload.primaryCategoryName ?? payload.primaryCategoryId;
    return `Primary category changed from ${before} to ${after}, with ${payload.additionalCategoryIds.length} secondary categories`;
  },
};
