import { ActionType } from '@/generated/prisma/enums';
import { updateSpecialHoursSchema } from '@/schemas/actions';
import type { ActionExecutor } from '@/server/actions/types';
import type { z } from 'zod';

type Payload = z.infer<typeof updateSpecialHoursSchema>;

/**
 * Sets holiday and other special hours, which override regular hours on the
 * dates given. The lowest-risk of the hours actions: it adds date-bounded
 * exceptions rather than changing the standing schedule.
 */
export const updateSpecialHoursExecutor: ActionExecutor<Payload> = {
  actionType: ActionType.UPDATE_SPECIAL_HOURS,
  schema: updateSpecialHoursSchema,

  buildPatch(payload) {
    return {
      patch: { specialHours: { specialHourPeriods: payload.periods } },
      updateMask: ['specialHours'],
    };
  },

  captureBefore(profile) {
    return { specialHours: profile.specialHours ?? null };
  },

  describe(payload) {
    const closedCount = payload.periods.filter((p) => p.closed).length;
    return `Special hours set for ${payload.periods.length} date(s), ${closedCount} marked closed`;
  },
};
