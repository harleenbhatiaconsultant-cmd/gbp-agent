import { ActionType } from '@/generated/prisma/enums';
import { updateRegularHoursSchema } from '@/schemas/actions';
import type { ActionExecutor } from '@/server/actions/types';
import type { z } from 'zod';

type Payload = z.infer<typeof updateRegularHoursSchema>;

/**
 * Sets regular opening hours.
 *
 * An empty periods array is a legitimate instruction meaning "no set hours",
 * but it also erases whatever is published, so the risk assessor escalates any
 * change that removes days the business currently advertises as open.
 */
export const updateRegularHoursExecutor: ActionExecutor<Payload> = {
  actionType: ActionType.UPDATE_REGULAR_HOURS,
  schema: updateRegularHoursSchema,

  buildPatch(payload) {
    return {
      patch: { regularHours: { periods: payload.periods } },
      updateMask: ['regularHours'],
    };
  },

  captureBefore(profile) {
    return { regularHours: profile.regularHours ?? null };
  },

  describe(payload) {
    const days = new Set(payload.periods.map((p) => p.openDay));
    return `Opening hours set for ${days.size} day(s) across ${payload.periods.length} period(s)`;
  },
};
