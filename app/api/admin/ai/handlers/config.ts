/**
 * app/api/admin/ai/handlers/config.ts — password-policy action handler.
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/platform/auth/audit";
import type { ActionResult } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function handleUpdatePasswordPolicy(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();

  const { error } = await supabase.from("password_policy").upsert(
    {
      role_id: null,
      user_id: null,
      min_length: input.min_length,
      rotation_days: input.rotation_days,
      require_uppercase: input.require_uppercase,
      require_lowercase: input.require_lowercase,
      require_number: input.require_number,
      require_special: input.require_special,
      password_history_count: input.password_history_count,
    },
    { onConflict: "role_id,user_id" }
  );

  if (error) return { success: false, error: error.message };

  await writeAuditLog({
    action: "admin_action",
    actorId,
    details: { type: "update_password_policy", prompt_action: true },
  });

  return { success: true, result: "Password policy updated" };
}
