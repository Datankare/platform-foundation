/**
 * platform/errors/registry.ts — The API error registry (ADR-051 D3, TASK-109)
 *
 * Every error the platform's API returns is one of these codes. Each code declares, once:
 *   - its HTTP status;
 *   - its parameters (returned in the body so any client can re-render the message in its own
 *     locale): `id` — an identifier returned verbatim, never translated (field, role, permission,
 *     provider, request id); `number`; `list` — a list of identifiers, formatted with the locale's
 *     list style when interpolated;
 *   - what the caller should do.
 * Its user-facing text is the catalog entry `errors.<code>` in messages/<locale>.json (ICU).
 *
 * A consuming app declares its own codes, `app.<area>.<name>`, in app-codes.ts (consumer-owned);
 * they are merged below, so every check and helper treats them like the platform's.
 *
 * A code, once shipped, is never repurposed — a changed meaning gets a new code. docs/API_ERRORS.md
 * is generated from this registry and the English catalog (see ./doc.ts); CI checks both agree.
 *
 * @module platform/errors
 */

import type { ErrorCodeSpec } from "@/platform/errors/spec";
import { APP_ERROR_CODES } from "@/platform/errors/app-codes";

export type {
  ErrorCodeSpec,
  ErrorParamKind,
  ErrorParamSpec,
} from "@/platform/errors/spec";

/** The platform's codes. A consuming app adds its own in app-codes.ts (ADR-051 D1). */
export const PLATFORM_ERROR_CODES = {
  "account.not_found": {
    status: 403,
    params: [],
    action: "Show sign-in / contact support.",
  },
  "account.not_provisioned": {
    status: 503,
    params: [],
    action:
      "Retry shortly; the account's platform record could not be created. If it persists, contact support.",
  },
  "account.restricted": {
    status: 403,
    params: [
      { name: "feature", kind: "id" },
      { name: "status", kind: "id" },
    ],
    action: "Show the restriction; offer appeal.",
  },
  "admin.config_invalid_value": {
    status: 422,
    params: [{ name: "key", kind: "id" }],
    action: "Show the setting's allowed type and range, and ask for a valid value.",
  },
  "admin.config_scope_refused": {
    status: 403,
    params: [{ name: "key", kind: "id" }],
    action:
      "Explain that this setting governs the platform and only an operator can change it; do not retry.",
  },
  "admin.operator_only": {
    status: 403,
    params: [],
    action:
      "Explain that this changes what every tenant shares, so only a platform operator can do it; do not retry.",
  },
  "admin.self_target": {
    status: 403,
    params: [],
    action: "Another administrator must take this action on your account.",
  },
  "admin.target_not_found": {
    status: 404,
    params: [{ name: "target", kind: "id" }],
    action: "Refresh the list and pick an existing item.",
  },
  "approvals.approver_not_allowed": {
    status: 403,
    params: [],
    action:
      "Ask the approver the approval policy names (a person, unless the policy says otherwise).",
  },
  "approvals.decision_conflict": {
    status: 409,
    params: [],
    action: "Refresh.",
  },
  "approvals.expired": {
    status: 409,
    params: [],
    action: "Tell the requester to submit the change again.",
  },
  "approvals.hold_not_found": {
    status: 404,
    params: [],
    action: "Refresh the list.",
  },
  "approvals.permission_required": {
    status: 403,
    params: [{ name: "permission", kind: "id" }],
    action: "Route to a holder of it.",
  },
  "approvals.self_approval": {
    status: 409,
    params: [],
    action: "Route to another approver.",
  },
  "auth.account_exists": {
    status: 409,
    params: [],
    action: "Offer sign-in or password reset.",
  },
  "auth.challenge_failed": {
    status: 401,
    params: [],
    action: "Restart the challenge.",
  },
  "auth.code_expired": {
    status: 400,
    params: [],
    action: "Offer resend.",
  },
  "auth.code_invalid": {
    status: 400,
    params: [],
    action: "Let the user retry.",
  },
  "auth.email_not_verified": {
    status: 403,
    params: [],
    action: "Show the verification step.",
  },
  "auth.grant_exceeds_own": {
    status: 403,
    params: [{ name: "permission", kind: "id" }],
    action: "Ask an administrator who holds the permission.",
  },
  "auth.guest_invalid": {
    status: 401,
    params: [],
    action: "Start a new guest session or show sign-in.",
  },
  "auth.invalid_credentials": {
    status: 401,
    params: [],
    action: "Let the user retry.",
  },
  "auth.password_policy": {
    status: 400,
    params: [{ name: "rules", kind: "list", optional: true }],
    action:
      "Show the password rules; `rules` lists the ids that failed when known (min_length, uppercase, lowercase, number, special, breached, repeated, sequential).",
  },
  "auth.permission_denied": {
    status: 403,
    params: [{ name: "permission", kind: "id" }],
    action: "Hide or disable the action.",
  },
  "auth.required": {
    status: 401,
    params: [],
    action: "Show sign-in.",
  },
  "auth.role_database_only": {
    status: 403,
    params: [{ name: "role", kind: "id" }],
    action: "Explain; no API path.",
  },
  "auth.role_protected": {
    status: 403,
    params: [{ name: "role", kind: "id" }],
    action: "Explain; no API path.",
  },
  "auth.role_self_change": {
    status: 403,
    params: [],
    action: "Ask another administrator.",
  },
  "auth.sign_in_required": {
    status: 401,
    params: [],
    action: "Show sign-in (guest on a users-only route).",
  },
  "auth.signups_closed": {
    status: 403,
    params: [],
    action: "Explain that new accounts are not being accepted here; do not retry.",
  },
  "auth.sso_failed": {
    status: 401,
    params: [{ name: "provider", kind: "id", optional: true }],
    action: "Offer another sign-in method.",
  },
  "auth.token_invalid": {
    status: 401,
    params: [],
    action: "Refresh the token, else show sign-in.",
  },
  "auth.too_many_attempts": {
    status: 429,
    params: [{ name: "retryAfterSeconds", kind: "number", optional: true }],
    action: "Back off.",
  },
  "content.rejected": {
    status: 422,
    params: [{ name: "category", kind: "id", optional: true }],
    action: "Ask for different input.",
  },
  "feature.not_configured": {
    status: 501,
    params: [{ name: "feature", kind: "id" }],
    action:
      "Hide the feature; it is not configured on this deployment (see GET /api/features). Retrying cannot succeed.",
  },
  "guest.allowance_exhausted": {
    status: 403,
    params: [{ name: "limit", kind: "number" }],
    action:
      "Show sign-in; the guest has used every free translation (the governed allowance).",
  },
  "internal.error": {
    status: 500,
    params: [{ name: "requestId", kind: "id" }],
    action: "Retry; report with the reference.",
  },
  "moderation.appeal_not_found": {
    status: 404,
    params: [],
    action: "—",
  },
  "moderation.appeal_not_allowed": {
    status: 400,
    params: [],
    action: "Hide the appeal action for this decision.",
  },
  "moderation.appeal_pending": {
    status: 409,
    params: [],
    action: "Show the pending appeal.",
  },
  "moderation.appeal_reason_too_short": {
    status: 400,
    params: [{ name: "min", kind: "number" }],
    action: "Ask for a longer reason.",
  },
  "moderation.appeal_window_expired": {
    status: 400,
    params: [{ name: "hours", kind: "number" }],
    action: "Explain the window has closed; no retry.",
  },
  "moderation.decision_not_found": {
    status: 404,
    params: [],
    action: "—",
  },
  "moderation.item_state_conflict": {
    status: 409,
    params: [{ name: "status", kind: "id" }],
    action: "Refresh the queue.",
  },
  "moderation.modified_action_required": {
    status: 400,
    params: [],
    action: "Prompt for it.",
  },
  "moderation.not_claimer": {
    status: 409,
    params: [{ name: "action", kind: "id" }],
    action: "Refresh the queue.",
  },
  "moderation.not_own_decision": {
    status: 403,
    params: [],
    action: "—",
  },
  "moderation.review_item_not_found": {
    status: 404,
    params: [],
    action: "—",
  },
  "moderation.self_review": {
    status: 403,
    params: [],
    action: "Route the item to another moderator.",
  },
  "rate.limited": {
    status: 429,
    params: [{ name: "retryAfterSeconds", kind: "number", optional: true }],
    action: "Back off.",
  },
  "request.invalid_body": {
    status: 400,
    params: [],
    action: "Fix the client request.",
  },
  "request.invalid_json": {
    status: 400,
    params: [],
    action: "Fix the client request.",
  },
  "request.field_not_accepted": {
    status: 400,
    params: [{ name: "field", kind: "id" }],
    action: "Stop sending the field; the server sets it.",
  },
  "request.invalid_value": {
    status: 400,
    params: [
      { name: "field", kind: "id" },
      { name: "allowed", kind: "list" },
    ],
    action: "Send one of the allowed values.",
  },
  "request.missing_fields": {
    status: 400,
    params: [{ name: "fields", kind: "list" }],
    action: "Send the listed fields.",
  },
  "request.text_empty": {
    status: 400,
    params: [],
    action: "Prompt for text.",
  },
  "request.text_too_long": {
    status: 400,
    params: [{ name: "max", kind: "number" }],
    action: "Shorten the text.",
  },
  "service.unavailable": {
    status: 503,
    params: [{ name: "service", kind: "id" }],
    action: "Retry later.",
  },
  "tenant.conflict": {
    status: 409,
    params: [{ name: "reason", kind: "id" }],
    action:
      "Show the reason (the slug or address is taken, or the tenant is not in the state this needs); refresh and choose again.",
  },
  "tenant.not_shared": {
    status: 409,
    params: [],
    action:
      "Explain that this deployment serves one tenant, whose settings are on the Platform Config page; do not retry.",
  },
  "tenant.not_active": {
    status: 409,
    params: [],
    action: "Explain that the tenant is deleted and awaiting purge; restore it first.",
  },
  "tenant.invalid": {
    status: 400,
    params: [],
    action: "Show what the tenant form needs and ask again.",
  },
  "tenant.not_found": {
    status: 404,
    params: [],
    action: "Refresh the tenant list; the tenant, request or user named does not exist.",
  },
  "tenant.own_tenant": {
    status: 403,
    params: [],
    action:
      "Explain that an operator cannot suspend or delete the tenant they operate from; do not retry.",
  },
  "tenant.self_approval": {
    status: 403,
    params: [],
    action: "Another operator must approve this deletion; do not retry as the requester.",
  },
  "tenant.mismatch": {
    status: 403,
    params: [],
    action:
      "The credentials belong to another tenant than this address serves. Sign in on your own organisation's address; do not retry here.",
  },
  "tenant.missing": {
    status: 403,
    params: [],
    action:
      "The account is not assigned to a tenant. An operator must assign it; retrying cannot succeed.",
  },
  "tenant.suspended": {
    status: 403,
    params: [],
    action:
      "The tenant is suspended. Show the message; contact the operator. Retrying cannot succeed.",
  },
  "tenant.unknown_host": {
    status: 404,
    params: [],
    action:
      "The address is not set up for any tenant. Check the address; retrying cannot succeed.",
  },
} as const satisfies Record<string, ErrorCodeSpec>;

/** Every code the API can return: the platform's, then the consuming app's (`app.*`). */
export const ERROR_CODES = { ...PLATFORM_ERROR_CODES, ...APP_ERROR_CODES } as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Codes the consuming app declared (app-codes.ts). */
export function isAppErrorCode(code: string): boolean {
  return code.startsWith("app.");
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(ERROR_CODES, value)
  );
}

/** The catalog key of a code's message. */
export function messageKey(code: ErrorCode): string {
  return `errors.${code}`;
}
