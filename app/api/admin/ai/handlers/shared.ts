/**
 * app/api/admin/ai/handlers/shared.ts — shared handler types, and the platform-catalog
 * transaction.
 *
 * The role, permission and entitlement catalog is shared by every tenant and read-only to the
 * request role (ADR-053 D5). A command-bar change to it is allowed only when
 * mayChangePlatformCatalog(admin) (platform/admin/config-scope.ts) — a single-tenant
 * deployment's administrators, a shared deployment's operators — and then runs on the owner
 * connection (catalogTx). Everything else the handlers touch is the tenant's own data
 * (withTenantTx).
 */

import { logger } from "@/lib/logger";
import { withOwnerTx, type Tx } from "@/platform/data";
import type { RoleRefusal } from "@/platform/auth/role-governance";
import { audited, AuditWriteError, type AuditEntry } from "@/platform/auth/audit";
import {
  describeFailure,
  type GovernedConfigOutcome,
} from "@/platform/admin/governed-config";

export type ActionResult = {
  success: boolean;
  result?: string;
  error?: string;
  /** The coded refusal, when an authorization rule refused the action (ADR-051). */
  code?: string;
  params?: Readonly<Record<string, string>>;
};

/** An action refused by an authorization rule, carrying its coded error. */
export function refusal(r: RoleRefusal): ActionResult {
  return { success: false, error: r.code, code: r.code, params: r.params };
}

/** A change to the shared catalog refused to an admin who may not make it (ADR-053 D5). */
export function operatorOnly(): ActionResult {
  return { success: false, error: "admin.operator_only", code: "admin.operator_only" };
}

/**
 * Run `fn` in one owner transaction, for a catalog change the caller has already allowed
 * (mayChangePlatformCatalog) — and for the reads that guard it, so they see what the change
 * will see.
 */
export function catalogTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withOwnerTx("operator", fn);
}

/**
 * Run a write that reports its own outcome; a thrown database error becomes a failed result
 * carrying its message, as a returned `{ error }` did before (the transaction rolled back).
 */
export async function failedAsResult(
  write: () => Promise<ActionResult>
): Promise<ActionResult> {
  try {
    return await write();
  } catch (err) {
    // The database's message (table, constraint, column) is logged, never shown; a unique
    // violation is said in plain words, since it is the admin's to fix.
    logger.error("Admin command write failed", {
      error: err instanceof Error ? err.message : String(err),
      route: "app/api/admin/ai/handlers",
    });
    if ((err as { code?: unknown } | null)?.code === "23505") {
      return { success: false, error: "That already exists: choose another name." };
    }
    return {
      success: false,
      error: "The change could not be saved: the database is unavailable or refused it.",
    };
  }
}

/** A governed config write's outcome as a command-bar result (audit X-7). */
export function fromGovernedConfig(
  outcome: GovernedConfigOutcome,
  key: string,
  summary: string
): ActionResult {
  switch (outcome.kind) {
    case "applied":
      return { success: true, result: summary };
    case "pending":
      return {
        success: true,
        result: `${summary} — held for approval before it takes effect`,
      };
    case "refused":
      return {
        success: false,
        error: "auth.permission_denied",
        code: "auth.permission_denied",
        params: { permission: outcome.permission },
      };
    case "refused_scope":
      return {
        success: false,
        error: outcome.reason,
        code: "admin.config_scope_refused",
        params: { key },
      };
    case "not_found":
      return {
        success: false,
        error: "admin.target_not_found",
        code: "admin.target_not_found",
        params: { target: key },
      };
    case "invalid":
      return {
        success: false,
        error: outcome.errors.join("; "),
        code: "admin.config_invalid_value",
        params: { key },
      };
    case "failed":
      return { success: false, error: describeFailure(outcome.result) };
  }
}

/**
 * Run a command-bar action after recording it (platform/auth/audit.ts audited): when the record
 * cannot be written the action does not run, and the admin is told why (audit X-8).
 */
export async function runAudited(
  entry: AuditEntry,
  act: () => Promise<ActionResult>
): Promise<ActionResult> {
  try {
    return await audited(entry, act);
  } catch (err) {
    if (err instanceof AuditWriteError) {
      return {
        success: false,
        error: "The audit log is unavailable, so the action was not run.",
        code: "service.unavailable",
        params: { service: "audit" },
      };
    }
    throw err;
  }
}
