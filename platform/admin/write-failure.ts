/**
 * platform/admin/write-failure.ts — what a config write that did not complete means, as a
 * registry code (TASK-194 round 14, item 3; round 15, P-1)
 *
 * One set of rules for every caller of the config store's writes — the config tools
 * (config-handlers writeFailure) and an approved two-person change's apply (config-approval
 * approveAndApply):
 *   - a value its entry refuses: `admin.config_invalid_value` with the structured reason;
 *   - a commit lost with its connection: `admin.write_indeterminate` (it may have applied);
 *   - the audit log unavailable: `service.unavailable { service: "audit" }` (nothing changed);
 *   - a code the write gave itself (a scope refused): that code;
 *   - else `admin.action_failed`.
 */

import type { ConfigValueRefusal } from "./types";
import { isErrorCode, type ErrorCode } from "@/platform/errors/registry";

/** `admin.config_invalid_value`'s params: the key and the structured reason (round 14, item 2). */
export type InvalidValueParams = {
  readonly key: string;
  readonly reason: string;
  readonly min?: number;
  readonly max?: number;
  readonly expected?: string;
  readonly allowed?: readonly string[];
};

/**
 * The params of `admin.config_invalid_value` for a value its entry refuses: the key and the
 * structured reason its message words (`other` when none is known).
 */
export function invalidValueParams(
  key: string,
  refusal: ConfigValueRefusal | undefined
): InvalidValueParams {
  return {
    key,
    reason: refusal?.reason ?? "other",
    ...(refusal?.min !== undefined ? { min: refusal.min } : {}),
    ...(refusal?.max !== undefined ? { max: refusal.max } : {}),
    ...(refusal?.expected !== undefined ? { expected: refusal.expected } : {}),
    ...(refusal?.allowed !== undefined ? { allowed: [...refusal.allowed] } : {}),
  };
}

/** What a config store write answered when it did not complete. */
export interface IncompleteWrite {
  readonly error?: string;
  readonly validationErrors?: readonly string[];
  readonly valueRefusal?: ConfigValueRefusal;
  readonly indeterminate?: boolean;
  readonly auditUnavailable?: boolean;
  readonly errorCode?: string;
  readonly errorParams?: Readonly<Record<string, string | number | readonly string[]>>;
}

/** The registry code and params of a write that did not complete (the rules above). */
export function writeFailureCode(
  key: string,
  result: IncompleteWrite
): {
  readonly code: ErrorCode;
  readonly params: Readonly<Record<string, string | number | readonly string[]>>;
} {
  if (result.validationErrors?.length || result.valueRefusal)
    return {
      code: "admin.config_invalid_value",
      params: invalidValueParams(key, result.valueRefusal),
    };
  if (result.indeterminate) return { code: "admin.write_indeterminate", params: {} };
  if (result.auditUnavailable)
    return { code: "service.unavailable", params: { service: "audit" } };
  if (typeof result.errorCode === "string" && isErrorCode(result.errorCode))
    return { code: result.errorCode, params: result.errorParams ?? {} };
  return { code: "admin.action_failed", params: {} };
}
