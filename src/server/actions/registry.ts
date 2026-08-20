/**
 * The executor registry.
 *
 * This is the complete list of mutations the platform can perform. An action
 * type with no entry here cannot be executed — the lookup fails loudly rather
 * than falling through to some generic handler. That property is what makes
 * "the LLM cannot execute arbitrary API mutations" true structurally rather
 * than by convention: the model can only name a member of the ActionType enum,
 * and only the entries below have any implementation behind them.
 */

import { ActionType } from '@/generated/prisma/enums';
import { BadRequestError } from '@/server/errors';
import type { ActionExecutor } from '@/server/actions/types';

import { updateTitleExecutor } from '@/server/actions/executors/update-title';
import { updateCategoriesExecutor } from '@/server/actions/executors/update-categories';
import { updateDescriptionExecutor } from '@/server/actions/executors/update-description';
import { updatePhoneExecutor } from '@/server/actions/executors/update-phone';
import { updateWebsiteExecutor } from '@/server/actions/executors/update-website';
import { updateAddressExecutor } from '@/server/actions/executors/update-address';
import { updateRegularHoursExecutor } from '@/server/actions/executors/update-regular-hours';
import { updateSpecialHoursExecutor } from '@/server/actions/executors/update-special-hours';

/**
 * Payload types differ per executor by design, and a registry keyed by action
 * cannot express that relationship without a mapped type that adds no safety
 * here. Each executor's Zod schema is the authority on its own shape, and
 * `proposeChange` parses through it before anything else happens.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyActionExecutor = ActionExecutor<any>;

const EXECUTORS: Partial<Record<ActionType, AnyActionExecutor>> = {
  [ActionType.UPDATE_TITLE]: updateTitleExecutor,
  [ActionType.UPDATE_CATEGORIES]: updateCategoriesExecutor,
  [ActionType.UPDATE_DESCRIPTION]: updateDescriptionExecutor,
  [ActionType.UPDATE_PHONE]: updatePhoneExecutor,
  [ActionType.UPDATE_WEBSITE]: updateWebsiteExecutor,
  [ActionType.UPDATE_ADDRESS]: updateAddressExecutor,
  [ActionType.UPDATE_REGULAR_HOURS]: updateRegularHoursExecutor,
  [ActionType.UPDATE_SPECIAL_HOURS]: updateSpecialHoursExecutor,
};

/** Action types with a working executor. */
export const IMPLEMENTED_ACTIONS = Object.keys(EXECUTORS) as ActionType[];

export function hasExecutor(actionType: ActionType): boolean {
  return actionType in EXECUTORS;
}

/**
 * Resolves an executor, or throws.
 *
 * The error names the phase the action belongs to rather than saying
 * "unsupported", so an unimplemented action reads as a roadmap item instead of
 * a bug.
 */
export function getExecutor(actionType: ActionType): AnyActionExecutor {
  const executor = EXECUTORS[actionType];

  if (!executor) {
    throw new BadRequestError(
      `No executor is implemented for ${actionType}. Posts, review replies and media use the legacy ` +
        'v4 API and are delivered in their own phases.',
      { actionType, implemented: IMPLEMENTED_ACTIONS },
    );
  }

  return executor;
}
