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
 * A code, once shipped, is never repurposed — a changed meaning gets a new code. docs/API_ERRORS.md
 * is generated from this registry and the English catalog (see ./doc.ts); CI checks both agree.
 *
 * @module platform/errors
 */

export type ErrorParamKind = "id" | "number" | "list";

export interface ErrorParamSpec {
  readonly name: string;
  readonly kind: ErrorParamKind;
  /** Sent only when known; never required by the message. */
  readonly optional?: boolean;
}

export interface ErrorCodeSpec {
  readonly status: number;
  readonly params: readonly ErrorParamSpec[];
  /** What a client or agent should do on receiving this code. */
  readonly action: string;
}

export const ERROR_CODES = {
  "account.not_found": {
    status: 403,
    params: [],
    action: "Show sign-in / contact support.",
  },
  "account.restricted": {
    status: 403,
    params: [
      { name: "feature", kind: "id" },
      { name: "status", kind: "id" },
    ],
    action: "Show the restriction; offer appeal.",
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
} as const satisfies Record<string, ErrorCodeSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(ERROR_CODES, value)
  );
}

/** The catalog key of a code's message. */
export function messageKey(code: ErrorCode): string {
  return `errors.${code}`;
}
