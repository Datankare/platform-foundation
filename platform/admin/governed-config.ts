/**
 * platform/admin/governed-config.ts — The one way an admin changes a config value (audit X-7)
 *
 * Every admin path that changes platform config — the config page, the config assistant, the
 * AI command bar's agent and capability actions — comes through writeGovernedConfig, so each
 * gets the same checks:
 *
 *   1. The admin holds the key's tier permission (config_manage_standard, or
 *      config_manage_safety for a safety-tier or unknown key).
 *   2. The value passes the key's validation, and the change is recorded in config history
 *      (handleUpdateConfig).
 *   3. Two-person approval and dual-control holds apply (dispatchConfigTool).
 *
 * Config keys are created and removed only by migrations; no admin path deletes one.
 *
 * @module platform/admin
 */

import { dispatchConfigTool } from "@/platform/admin/config-handlers";
import { getEnhancedConfig } from "@/platform/auth/platform-config";
import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import type { ConfigToolResult, ToolExecutionContext } from "@/platform/admin/types";

/** The permission a change to a key of this tier requires. */
export function tierPermission(tier: string): string {
  return tier === "standard" ? "config_manage_standard" : "config_manage_safety";
}

export interface GovernedConfigWrite {
  readonly key: string;
  readonly value: unknown;
  readonly changeComment: string;
}

export type GovernedConfigOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "refused"; readonly permission: string }
  | { readonly kind: "invalid"; readonly errors: readonly string[] }
  | { readonly kind: "applied"; readonly result: ConfigToolResult }
  | { readonly kind: "pending"; readonly result: ConfigToolResult }
  | { readonly kind: "failed"; readonly result: ConfigToolResult };

/** Apply, hold or refuse one config change on behalf of a verified admin. */
export async function writeGovernedConfig(
  admin: VerifiedAdmin,
  change: GovernedConfigWrite,
  context?: ToolExecutionContext
): Promise<GovernedConfigOutcome> {
  const entry = await getEnhancedConfig(change.key);
  if (!entry) return { kind: "not_found" };
  const permission = tierPermission(entry.permissionTier);
  if (!holds(admin, permission)) return { kind: "refused", permission };

  const result = await dispatchConfigTool(
    "update_config",
    {
      key: change.key,
      value: change.value,
      changeComment: change.changeComment,
      actorId: admin.userId,
      confirmed: true,
    },
    context
  );

  if (result.held) return { kind: "pending", result };
  const data = (result.data ?? {}) as {
    applied?: boolean;
    requiresApproval?: boolean;
    validationErrors?: string[];
  };
  if (data.validationErrors?.length)
    return { kind: "invalid", errors: data.validationErrors };
  if (result.success && data.requiresApproval) return { kind: "pending", result };
  if (result.success && data.applied) return { kind: "applied", result };
  return { kind: "failed", result };
}

/** A short reason for a failed outcome, for logs and command-bar replies. */
export function describeFailure(result: ConfigToolResult): string {
  const data = (result.data ?? {}) as { error?: string; validationErrors?: string[] };
  return (
    result.error ??
    data.error ??
    (data.validationErrors?.length
      ? data.validationErrors.join("; ")
      : "Config change failed")
  );
}
