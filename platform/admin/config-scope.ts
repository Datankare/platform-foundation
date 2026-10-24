/**
 * platform/admin/config-scope.ts — where an admin's config change goes (ADR-053 D5)
 *
 *   single-tenant deployment   the platform default — the tenant is the whole platform, so its
 *                              administrators govern every key, as before tenancy
 *   shared deployment          the tenant's own value, for keys a tenant may set; an operator
 *                              (platform_operate) may set any key for a tenant, and only an
 *                              operator may change the platform default every tenant inherits
 *
 * The key's tier permission (governed-config.ts) is checked as well; this decides only the
 * target.
 *
 * @module platform/admin
 */

import { peekTenant } from "@/platform/tenancy/context";
import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import type { ConfigWriteTarget } from "@/platform/auth/platform-config";
import type { ConfigScope, EnhancedConfigEntry } from "./types";

/** The permission that makes an admin an operator: platform-wide powers. */
export const OPERATOR_PERMISSION = "platform_operate";

export function isOperator(admin: VerifiedAdmin): boolean {
  return holds(admin, OPERATOR_PERMISSION);
}

/** True in a shared (multi-tenant) deployment's request. */
export function isSharedDeployment(): boolean {
  return peekTenant()?.mode === "shared";
}

export type ConfigTargetDecision =
  | { readonly ok: true; readonly target: ConfigWriteTarget }
  | { readonly ok: false; readonly reason: string };

/**
 * The target of a change to `entry` by an admin who is (`operator`) or is not an operator.
 * `requested` is what the admin asked for; when absent, a shared deployment means the tenant's
 * own value.
 */
export function resolveConfigTarget(
  operator: boolean,
  entry: Pick<EnhancedConfigEntry, "key" | "tenantOverridable">,
  requested?: ConfigScope
): ConfigTargetDecision {
  if (!isSharedDeployment()) {
    return { ok: true, target: { scope: "platform", operator } };
  }
  if (requested === "platform") {
    return operator
      ? { ok: true, target: { scope: "platform", operator: true } }
      : { ok: false, reason: "Only an operator can change a platform default." };
  }
  if (!entry.tenantOverridable && !operator) {
    return {
      ok: false,
      reason: `"${entry.key}" governs the platform; only an operator can set it.`,
    };
  }
  return { ok: true, target: { scope: "tenant", operator } };
}

/** The target for applying an approved change: its recorded scope, as the reviewer (`operator`). */
export function approvedChangeTarget(
  operator: boolean,
  scope: ConfigScope
): ConfigTargetDecision {
  if (isSharedDeployment() && scope === "platform" && !operator) {
    return {
      ok: false,
      reason: "Only an operator can approve a change to a platform default.",
    };
  }
  return { ok: true, target: { scope, operator } };
}

/**
 * Whether `admin` may change what every tenant shares — the role and permission catalog, the
 * entitlement catalog: in a single-tenant deployment its administrators (the role rules still
 * apply), in a shared one only an operator. Such changes run on the owner connection.
 */
export function mayChangePlatformCatalog(admin: VerifiedAdmin): boolean {
  return !isSharedDeployment() || isOperator(admin);
}
