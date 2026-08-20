import { ActionType } from '@/generated/prisma/enums';
import { updateDescriptionSchema } from '@/schemas/actions';
import type { ActionExecutor } from '@/server/actions/types';
import type { z } from 'zod';

type Payload = z.infer<typeof updateDescriptionSchema>;

/**
 * Sets the business description. The one field where a model may legitimately
 * be the author, which is why the fabrication guard permits AI_GENERATED here
 * and the content guardrails scrutinise the text instead.
 */
export const updateDescriptionExecutor: ActionExecutor<Payload> = {
  actionType: ActionType.UPDATE_DESCRIPTION,
  schema: updateDescriptionSchema,

  buildPatch(payload) {
    return {
      patch: { profile: { description: payload.description } },
      updateMask: ['profile.description'],
    };
  },

  captureBefore(profile) {
    return { description: profile.profile?.description ?? null };
  },

  describe(payload, profile) {
    const had = Boolean(profile.profile?.description);
    return had
      ? `Business description rewritten (${payload.description.length} characters)`
      : `Business description added (${payload.description.length} characters)`;
  },
};
