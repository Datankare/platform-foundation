/**
 * app/api/admin/ai/handlers/shared.ts — shared handler types.
 */

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
