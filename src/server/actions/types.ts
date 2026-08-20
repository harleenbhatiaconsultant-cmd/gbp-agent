/**
 * The action executor contract.
 *
 * An executor knows how to turn one validated payload into a Google API patch,
 * and how to record what it is about to overwrite. It does NOT decide whether
 * the change is allowed, when it runs, or whether it may touch a live profile —
 * that is the policy engine, the approval queue and the write-mode gate
 * respectively. Keeping executors this narrow is what makes each one trivially
 * testable and hard to misuse.
 *
 * `buildPatch` returns an `updateMask` alongside the patch. Google replaces
 * only the masked fields, so a mask that is wider than the patch silently
 * ERASES data. Every executor lists exactly the fields it sets.
 */

import type { ZodType } from 'zod';
import type { ActionType } from '@/generated/prisma/enums';
import type { GbpLocationResource } from '@/server/integrations/google/types';

export interface ActionPatch {
  patch: Partial<GbpLocationResource>;
  /** Field paths Google is permitted to replace. Must match the patch exactly. */
  updateMask: string[];
}

export interface ActionExecutor<TPayload = unknown> {
  readonly actionType: ActionType;
  readonly schema: ZodType<TPayload>;

  /** Translates a validated payload into a Google patch. Pure. */
  buildPatch(payload: TPayload): ActionPatch;

  /**
   * The current values this change would overwrite, recorded as `beforeState`
   * so the change log can show what was actually replaced — and so a rollback
   * payload exists if one is ever needed.
   */
  captureBefore(profile: GbpLocationResource): Record<string, unknown>;

  /** One-line summary for the client-facing change log. */
  describe(payload: TPayload, profile: GbpLocationResource): string;
}
