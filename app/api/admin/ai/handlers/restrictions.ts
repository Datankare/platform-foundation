/**
 * app/api/admin/ai/handlers/restrictions.ts — per-account feature restriction handlers (U6).
 *
 * GenAI-native governance admin (ADR-035) over the F1 per-account block store (ADR-034). A
 * block bars one feature for one user, orthogonal to account status. Vocabulary-free: the
 * feature is an opaque string; the handler does not enumerate features.
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/platform/auth/audit";
import type { ActionResult } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Block a feature for a user (idempotent — re-blocking is a no-op via the composite PK). */
export async function handleBlockUserFeature(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const userId: string = input.user_id;
  const feature: string = input.feature;
  if (!userId || !feature) {
    return { success: false, error: "user_id and feature are required" };
  }
  const supabase = getSupabaseServiceClient();
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
  await writeAuditLog({
    action: "admin_action",
    actorId,
    details: {
      type: "block_user_feature",
      prompt_action: true,
      user_id: userId,
      feature,
      reason: input.reason ?? null,
    },
  });
  return { success: true, result: `Blocked "${feature}" for user ${userId}` };
}

/** Lift a per-account block. */
export async function handleUnblockUserFeature(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const userId: string = input.user_id;
  const feature: string = input.feature;
  if (!userId || !feature) {
    return { success: false, error: "user_id and feature are required" };
  }
  const supabase = getSupabaseServiceClient();
  const { error } = await supabase
    .from("user_feature_restrictions" as never)
    .delete()
    .eq("user_id", userId)
    .eq("feature", feature);
  if (error) return { success: false, error: error.message };
  await writeAuditLog({
    action: "admin_action",
    actorId,
    details: {
      type: "unblock_user_feature",
      prompt_action: true,
      user_id: userId,
      feature,
    },
  });
  return { success: true, result: `Unblocked "${feature}" for user ${userId}` };
}
