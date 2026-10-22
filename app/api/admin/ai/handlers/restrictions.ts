/**
 * app/api/admin/ai/handlers/restrictions.ts — per-account feature restriction handlers (U6).
 *
 * GenAI-native governance admin (ADR-035) over the F1 per-account block store (ADR-034). A
 * block bars one feature for one user, orthogonal to account status. Vocabulary-free: the
 * feature is an opaque string; the handler does not enumerate features.
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { runAudited, type ActionResult } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A refusal for a missing or malformed user id or feature, or null. */
function inputProblem(userId: unknown, feature: unknown): ActionResult | null {
  if (!userId || !feature)
    return { success: false, error: "user_id and feature are required" };
  if (typeof userId !== "string" || !USER_ID.test(userId)) {
    return {
      success: false,
      error: "user_id must be a user id",
      code: "request.invalid_value",
      params: { field: "user_id", allowed: "a user id" },
    };
  }
  if (typeof feature !== "string")
    return { success: false, error: "feature must be a string" };
  return null;
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
  // An administrator does not place or lift a restriction on their own account (release review).
  if (userId === actorId) {
    return { success: false, error: "admin.self_target", code: "admin.self_target" };
  }
  const supabase = getSupabaseServiceClient();
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
    async () => {
      const { error } = await supabase.from("user_feature_restrictions" as never).upsert(
        {
          user_id: userId,
          feature,
          reason: input.reason ?? null,
          created_by: actorId,
        } as never,
        { onConflict: "user_id,feature" }
      );
      if (error) return { success: false, error: error.message };
      return { success: true, result: `Blocked "${feature}" for user ${userId}` };
    }
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
  // An administrator does not place or lift a restriction on their own account (release review).
  if (userId === actorId) {
    return { success: false, error: "admin.self_target", code: "admin.self_target" };
  }
  const supabase = getSupabaseServiceClient();
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
    async () => {
      const { error } = await supabase
        .from("user_feature_restrictions" as never)
        .delete()
        .eq("user_id", userId)
        .eq("feature", feature);
      if (error) return { success: false, error: error.message };
      return { success: true, result: `Unblocked "${feature}" for user ${userId}` };
    }
  );
}
