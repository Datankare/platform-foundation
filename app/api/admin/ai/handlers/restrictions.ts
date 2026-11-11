/**
 * app/api/admin/ai/handlers/restrictions.ts — per-account feature restriction handlers (U6).
 *
 * GenAI-native governance admin (ADR-035) over the F1 per-account block store (ADR-034). A
 * block bars one feature for one user, orthogonal to account status. Vocabulary-free: the
 * feature is an opaque string; the handler does not enumerate features.
 *
 * Restrictions are the tenant's own data (ADR-053 D5), written in the tenant's transaction: a
 * block names a user of this tenant (the foreign key refuses any other), and an unblock removes
 * only this tenant's row.
 */

import { shown } from "@/platform/errors/shown-text";
import { withTenantTx } from "@/platform/data";
import {
  coded,
  failedAsResult,
  NO_FACTS,
  runAudited,
  type ActionResult,
  type ApproverRule,
} from "./shared";
import { sameId } from "@/platform/auth/same-id";

/* eslint-disable @typescript-eslint/no-explicit-any */

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A refusal for a missing or malformed user id or feature, or null. */
function inputProblem(userId: unknown, feature: unknown): ActionResult | null {
  if (typeof userId !== "string" || !USER_ID.test(userId)) {
    return coded("request.invalid_value", {
      field: "user_id",
      allowed: ["user_id"],
      expected: "user_id",
    });
  }
  if (typeof feature !== "string" || !feature) {
    return coded("request.missing_fields", { fields: ["feature"] });
  }
  return null;
}

/**
 * The restriction's rule for `admin` — the requester, or an approver of a held one (TASK-194
 * round 1, A3: registered in APPROVER_RULES): an administrator does not place or lift a
 * restriction on their own account (release review). The coded refusal, or null.
 */
function decideRestrictionTarget(
  input: Record<string, any>,
  _facts: null,
  admin: { readonly userId: string }
): ActionResult | null {
  return sameId(input.user_id, admin.userId)
    ? { success: false, error: "admin.self_target", code: "admin.self_target" }
    : null;
}

export const restrictionTargetRule: ApproverRule<null> = {
  facts: NO_FACTS,
  decide: decideRestrictionTarget,
};

export async function checkRestrictionTarget(
  input: Record<string, any>,
  admin: { readonly userId: string }
): Promise<ActionResult | null> {
  return decideRestrictionTarget(input, null, admin);
}

/** Block a feature for a user (idempotent — re-blocking is a no-op via the composite PK). */
export async function handleBlockUserFeature(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const userId: string = input.user_id;
  const feature: string = input.feature;
  const problem = inputProblem(userId, feature);
  if (problem) return problem;
  const self = await checkRestrictionTarget(input, { userId: actorId });
  if (self) return self;
  return runAudited(
    {
      action: "admin_action",
      actorId,
      targetId: userId,
      details: {
        type: "block_user_feature",
        prompt_action: true,
        user_id: userId,
        feature,
        reason: input.reason ?? null,
      },
    },
    () =>
      failedAsResult(async () => {
        await withTenantTx((tx) =>
          tx.query(
            `insert into user_feature_restrictions (user_id, feature, reason, created_by)
             values ($1::uuid, $2, $3, $4)
             on conflict (tenant_id, user_id, feature)
             do update set reason = excluded.reason, created_by = excluded.created_by`,
            [userId, feature, input.reason ?? null, actorId]
          )
        );
        return {
          success: true,
          result: shown("screens.admin_console.results.feature_blocked", { feature }),
        };
      })
  );
}

/** Lift a per-account block. */
export async function handleUnblockUserFeature(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const userId: string = input.user_id;
  const feature: string = input.feature;
  const problem = inputProblem(userId, feature);
  if (problem) return problem;
  const self = await checkRestrictionTarget(input, { userId: actorId });
  if (self) return self;
  return runAudited(
    {
      action: "admin_action",
      actorId,
      targetId: userId,
      details: {
        type: "unblock_user_feature",
        prompt_action: true,
        user_id: userId,
        feature,
      },
    },
    () =>
      failedAsResult(async () => {
        await withTenantTx((tx) =>
          tx.query(
            "delete from user_feature_restrictions where user_id = $1::uuid and feature = $2",
            [userId, feature]
          )
        );
        return {
          success: true,
          result: shown("screens.admin_console.results.feature_unblocked", { feature }),
        };
      })
  );
}
