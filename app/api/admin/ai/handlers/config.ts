/**
 * app/api/admin/ai/handlers/config.ts — password-policy action handler.
 *
 * The command bar's input uses snake_case field names; they are mapped to the policy's fields and
 * validated exactly as the password-policy admin route validates them.
 */

import {
  applyPasswordPolicyChange,
  getGlobalPasswordPolicy,
  saveGlobalPasswordPolicy,
} from "@/platform/auth/password-policy";
import { runAudited, type ActionResult } from "./shared";

const FIELDS: Readonly<Record<string, string>> = {
  min_length: "minLength",
  rotation_days: "rotationDays",
  require_uppercase: "requireUppercase",
  require_lowercase: "requireLowercase",
  require_number: "requireNumber",
  require_special: "requireSpecial",
  password_history_count: "passwordHistoryCount",
};

export async function handleUpdatePasswordPolicy(
  input: Readonly<Record<string, unknown>>,
  actorId: string
): Promise<ActionResult> {
  const change: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(input ?? {})) {
    change[FIELDS[field] ?? field] = value;
  }

  const current = await getGlobalPasswordPolicy();
  const applied = applyPasswordPolicyChange(current, change);
  if ("field" in applied) {
    return {
      success: false,
      error: `${applied.field} must be ${applied.allowed}`,
      code: "request.invalid_value",
      params: { field: applied.field, allowed: applied.allowed },
    };
  }

  return runAudited(
    {
      action: "admin_action",
      actorId,
      details: {
        type: "update_password_policy",
        prompt_action: true,
        previous: current,
        policy: applied.policy,
      },
    },
    async () => {
      const saved = await saveGlobalPasswordPolicy(applied.policy);
      if (!saved.success) return { success: false, error: saved.error };
      return { success: true, result: "Password policy updated" };
    }
  );
}
