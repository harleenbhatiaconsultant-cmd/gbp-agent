import { ActionType } from '@/generated/prisma/enums';
import { updateWebsiteSchema } from '@/schemas/actions';
import type { ActionExecutor } from '@/server/actions/types';
import type { z } from 'zod';

type Payload = z.infer<typeof updateWebsiteSchema>;

export const updateWebsiteExecutor: ActionExecutor<Payload> = {
  actionType: ActionType.UPDATE_WEBSITE,
  schema: updateWebsiteSchema,

  buildPatch(payload) {
    return { patch: { websiteUri: payload.websiteUri }, updateMask: ['websiteUri'] };
  },

  captureBefore(profile) {
    return { websiteUri: profile.websiteUri ?? null };
  },

  describe(payload, profile) {
    const before = profile.websiteUri;
    return before
      ? `Website changed from ${before} to ${payload.websiteUri}`
      : `Website set to ${payload.websiteUri}`;
  },
};
