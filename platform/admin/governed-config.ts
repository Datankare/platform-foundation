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
 *   4. The change goes where the deployment allows (ADR-053 D5, config-scope.ts): the platform
 *      default in a single-tenant deployment; in a shared one, the tenant's own value — any key
 *      for an operator, tenant-settable keys for a tenant's administrators — or, for an
 *      operator who asks for it, the platform default.
 *
 * resetGovernedConfig is the same for removing a tenant's own value (back to the platform
 * default): tier permission, scope, two-person approval and dual control (reset_config).
 *
 * Config keys are created and removed only by migrations; no admin path deletes one.
 *
 * @module platform/admin
 */

import { dispatchConfigTool } from "@/platform/admin/config-handlers";
import { getEnhancedConfig } from "@/platform/auth/platform-config";
import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import { isOperator, resolveConfigTarget } from "@/platform/admin/config-scope";
import type {
  ConfigScope,
  ConfigToolResult,
  ToolExecutionContext,
} from "@/platform/admin/types";

/** The permission a change to a key of this tier requires. */
export function tierPermission(tier: string): string {
  return tier === "standard" ? "config_manage_standard" : "config_manage_safety";
}

export interface GovernedConfigWrite {
  readonly key: string;
  readonly value: unknown;
  readonly changeComment: string;
  /** What the change is to; absent means the deployment's default (config-scope.ts). */
  readonly scope?: ConfigScope;
}

export type GovernedConfigOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "refused"; readonly permission: string }
  | { readonly kind: "refused_scope"; readonly reason: string }
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
  const operator = isOperator(admin);
  const decision = resolveConfigTarget(operator, entry, change.scope);
  if (!decision.ok) return { kind: "refused_scope", reason: decision.reason };

  const result = await dispatchConfigTool(
    "update_config",
    {
      key: change.key,
      value: change.value,
      changeComment: change.changeComment,
      actorId: admin.userId,
      actorIsOperator: operator,
      ...(change.scope ? { scope: change.scope } : {}),
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

export interface GovernedConfigReset {
  readonly key: string;
  readonly changeComment: string;
}

/**
 * Remove the current tenant's own value for a key on behalf of a verified admin: "applied"
 * (or applied with nothing to change), "pending" when held or awaiting approval, or refused.
 */
export async function resetGovernedConfig(
  admin: VerifiedAdmin,
  change: GovernedConfigReset,
  context?: ToolExecutionContext
): Promise<GovernedConfigOutcome> {
  const entry = await getEnhancedConfig(change.key);
  if (!entry) return { kind: "not_found" };
  const permission = tierPermission(entry.permissionTier);
  if (!holds(admin, permission)) return { kind: "refused", permission };
  const operator = isOperator(admin);
  const decision = resolveConfigTarget(operator, entry, "tenant");
  if (!decision.ok) return { kind: "refused_scope", reason: decision.reason };

  const result = await dispatchConfigTool(
    "reset_config",
    {
      key: change.key,
      changeComment: change.changeComment,
      actorId: admin.userId,
      actorIsOperator: operator,
      confirmed: true,
    },
    context
  );
  if (result.held) return { kind: "pending", result };
  const data = (result.data ?? {}) as { applied?: boolean; requiresApproval?: boolean };
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
