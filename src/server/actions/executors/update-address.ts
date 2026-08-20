import { ActionType } from '@/generated/prisma/enums';
import { updateAddressSchema } from '@/schemas/actions';
import type { ActionExecutor } from '@/server/actions/types';
import type { z } from 'zod';

type Payload = z.infer<typeof updateAddressSchema>;

/**
 * Sets the storefront address.
 *
 * Address edits frequently trigger Google re-verification, which can take a
 * profile offline temporarily. That is why this action is classified HIGH risk
 * and can never auto-apply.
 */
export const updateAddressExecutor: ActionExecutor<Payload> = {
  actionType: ActionType.UPDATE_ADDRESS,
  schema: updateAddressSchema,

  buildPatch(payload) {
    return {
      patch: {
        storefrontAddress: {
          regionCode: payload.regionCode,
          languageCode: payload.languageCode,
          postalCode: payload.postalCode,
          administrativeArea: payload.administrativeArea,
          locality: payload.locality,
          addressLines: payload.addressLines,
        },
      },
      updateMask: ['storefrontAddress'],
    };
  },

  captureBefore(profile) {
    return { storefrontAddress: profile.storefrontAddress ?? null };
  },

  describe(payload) {
    const summary = [...payload.addressLines, payload.locality, payload.administrativeArea]
      .filter(Boolean)
      .join(", ");
    return `Storefront address set to ${summary}`;
  },
};
