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
 *   3. Two-person approval and dual-control holds apply (dispatchConfigTool), always: a write to
 *      a dual-controlled key is held under the key's own rules — the approver needs the key's
 *      tier permission (requiredPermissionForKey), may not be the requester, must be an operator
 *      for a shared deployment's platform default (approvedChangeTarget), and the approval
 *      lapses (config.approval_expiry_days). Nothing a caller presents lets a write skip it: the
 *      command bar's config-writing actions are not held as actions at all, so this is the one
 *      hold on their effect (review 10 H1, H3 — the approval capability of review 9 let an
 *      action-level approval, cleared by a lesser approver, stand in for the key's).
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

import {
  codedConfigFailure,
  dispatchConfigTool,
  type InvalidValueParams,
} from "@/platform/admin/config-handlers";
import type { ErrorCode } from "@/platform/errors/registry";
import type { ShownText } from "@/platform/errors/shown-text";
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
  /** What the person wrote, as written ("" when the platform's note says why). */
  readonly changeComment: string;
  /**
   * The platform's own note on the change (TASK-209), when no person wrote one: a catalog key and
   * values, stored as such — never English.
   */
  readonly changeShown?: ShownText;
  /** What the change is to; absent means the deployment's default (config-scope.ts). */
  readonly scope?: ConfigScope;
}

export type GovernedConfigOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "refused"; readonly permission: string }
  | { readonly kind: "refused_scope"; readonly reason: string }
  /**
   * A value its entry refuses: `params` are `admin.config_invalid_value`'s (the key and the
   * structured reason, round 14 item 2); `errors` the entry's English reasons, for the log.
   */
  | {
      readonly kind: "invalid";
      readonly errors: readonly string[];
      readonly params: InvalidValueParams;
    }
  | { readonly kind: "applied"; readonly result: ConfigToolResult }
  | { readonly kind: "pending"; readonly result: ConfigToolResult }
  /**
   * It did not go through. `code`/`params`: its registry code when the result carries one — a
   * change already waiting (`approvals.already_pending`), the audit log unavailable, a stale or
   * lost commit (round 14, item 1: the code was dropped here, and every surface answered 500 or
   * `admin.action_failed`); absent, the caller answers its generic failure.
   */
  | {
      readonly kind: "failed";
      readonly result: ConfigToolResult;
      readonly code?: ErrorCode;
      readonly params?: Readonly<Record<string, string | number | readonly string[]>>;
    };

/** A failed outcome, with the result's code when it has one (round 14, item 1). */
function failed(result: ConfigToolResult): GovernedConfigOutcome {
  const coded = codedConfigFailure(result);
  return coded ? { kind: "failed", result, ...coded } : { kind: "failed", result };
}

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

  const input = {
    key: change.key,
    value: change.value,
    changeComment: change.changeComment,
    ...(change.changeShown ? { changeShown: change.changeShown } : {}),
    actorId: admin.userId,
    actorIsOperator: operator,
    ...(change.scope ? { scope: change.scope } : {}),
    confirmed: true,
  };
  const result = await dispatchConfigTool("update_config", input, context);

  if (result.held) return { kind: "pending", result };
  const data = (result.data ?? {}) as {
    applied?: boolean;
    requiresApproval?: boolean;
    approvalError?: string;
    validationErrors?: string[];
  };
  const coded = codedConfigFailure(result);
  if (
    coded?.code === "admin.config_invalid_value" ||
    (!coded && data.validationErrors?.length)
  )
    return {
      kind: "invalid",
      errors: data.validationErrors ?? [],
      params:
        coded?.code === "admin.config_invalid_value"
          ? (coded.params as unknown as InvalidValueParams)
          : { key: change.key, reason: "other" },
    };
  // Pending only when it was filed (round 13, P-1): a filing refused (a change to the key already
  // waiting) is a failure, never reported as pending.
  if (result.success && data.requiresApproval && !data.approvalError)
    return { kind: "pending", result };
  if (result.success && data.applied) return { kind: "applied", result };
  return failed(result);
}

export interface GovernedConfigReset {
  readonly key: string;
  /** As GovernedConfigWrite's: the person's comment, or "" beside the platform's note. */
  readonly changeComment: string;
  readonly changeShown?: ShownText;
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
      ...(change.changeShown ? { changeShown: change.changeShown } : {}),
      actorId: admin.userId,
      actorIsOperator: operator,
      confirmed: true,
    },
    context
  );
  if (result.held) return { kind: "pending", result };
  const data = (result.data ?? {}) as {
    applied?: boolean;
    requiresApproval?: boolean;
    approvalError?: string;
  };
  if (result.success && data.requiresApproval && !data.approvalError)
    return { kind: "pending", result };
  if (result.success && data.applied) return { kind: "applied", result };
  return failed(result);
}

/** A short reason for a failed outcome, for logs and command-bar replies. */
export function describeFailure(result: ConfigToolResult): string {
  const data = (result.data ?? {}) as {
    error?: string;
    approvalError?: string;
    validationErrors?: string[];
  };
  return (
    result.error ??
    data.approvalError ??
    data.error ??
    (data.validationErrors?.length
      ? data.validationErrors.join("; ")
      : "Config change failed")
  );
}
