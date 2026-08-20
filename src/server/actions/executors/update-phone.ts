import { ActionType } from '@/generated/prisma/enums';
import { updatePhoneSchema } from '@/schemas/actions';
import type { ActionExecutor } from '@/server/actions/types';
import type { z } from 'zod';

type Payload = z.infer<typeof updatePhoneSchema>;

/**
 * Sets the phone numbers.
 *
 * The mask covers the whole phoneNumbers object, so additionalPhones is always
 * sent explicitly: masking the parent while omitting the field would clear any
 * existing additional numbers.
 */
export const updatePhoneExecutor: ActionExecutor<Payload> = {
  actionType: ActionType.UPDATE_PHONE,
  schema: updatePhoneSchema,

  buildPatch(payload) {
    return {
      patch: {
        phoneNumbers: {
          primaryPhone: payload.primaryPhone,
          additionalPhones: payload.additionalPhones,
        },
      },
      updateMask: ['phoneNumbers'],
    };
  },

  captureBefore(profile) {
    return {
      primaryPhone: profile.phoneNumbers?.primaryPhone ?? null,
      additionalPhones: profile.phoneNumbers?.additionalPhones ?? [],
    };
  },

  describe(payload, profile) {
    const before = profile.phoneNumbers?.primaryPhone;
    return before
      ? `Primary phone changed from ${before} to ${payload.primaryPhone}`
      : `Primary phone set to ${payload.primaryPhone}`;
  },
};
