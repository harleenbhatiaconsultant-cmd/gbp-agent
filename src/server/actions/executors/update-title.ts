import { ActionType } from '@/generated/prisma/enums';
import { updateTitleSchema } from '@/schemas/actions';
import type { ActionExecutor } from '@/server/actions/types';
import type { z } from 'zod';

type Payload = z.infer<typeof updateTitleSchema>;

/**
 * Renames the profile. Reaching an executor at all means the policy engine
 * already cleared the name (see business-name-integrity) and a named human
 * approved it, because UPDATE_TITLE can never auto-apply.
 */
export const updateTitleExecutor: ActionExecutor<Payload> = {
  actionType: ActionType.UPDATE_TITLE,
  schema: updateTitleSchema,

  buildPatch(payload) {
    return { patch: { title: payload.title }, updateMask: ['title'] };
  },

  captureBefore(profile) {
    return { title: profile.title ?? null };
  },

  describe(payload, profile) {
    return `Business name changed from "${profile.title ?? "(none)"}" to "${payload.title}"`;
  },
};
