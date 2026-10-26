/**
 * platform/errors/refusal.ts — one way for every screen to handle a refused API call (TASK-181)
 *
 * Every refusal the API returns carries a registered code (ADR-051). What a screen must DO about
 * it depends on the code, not on the screen: an unrecorded age asks for the date, a restricted
 * account shows its status with sign-out, an erased account ends the session, a rate limit says
 * when to try again. Screens showed one "refused" text, or nothing, instead (the October 2026
 * user-facing gap audit). This module is the single decision:
 *
 *   REFUSAL_HANDLERS          every platform code → the kind of handling it needs (exhaustive:
 *                             tsc refuses a new platform code without a decision)
 *   handleRefusal(code, …)    the Refusal a screen renders: kind, code, message, retry delay
 *   readRefusal(res)          the same, from a refused Response's coded body
 *   fetchWithProvisioningRetry  a request retried with backoff while the account is still being
 *                             set up (`account.not_provisioned`)
 *
 * The components that render each kind are in components/refusal/. A consuming app's own codes
 * (`app.*`) are kind "message" (the server's own words); a caller that does more for one declares
 * it in its `HANDLED_CODES` — __tests__/refusal-coverage.test.ts checks every (caller, code) pair.
 *
 * Client-safe: no server imports.
 *
 * @module platform/errors
 */

import {
  isErrorCode,
  messageKey,
  type ErrorCode,
  type PlatformErrorCode,
} from "@/platform/errors/registry";
import { renderMessage } from "@/platform/errors/messages";

export type RefusalKind =
  /** Ask for the date of birth (POST /api/account/age), then retry. */
  | "age-gate"
  /** A parent or guardian must consent: an informational wait, not an error. */
  | "consent-wait"
  /** The account is restricted: show its status, with sign-out. */
  | "restricted"
  /** The account is gone or cannot be matched: end the session and show sign-in with the message. */
  | "signed-out-erased"
  /** The account is still being set up: retry with backoff. */
  | "not-provisioned"
  /** The deployment's tenant cannot serve this request: a full-page notice. */
  | "tenant-unavailable"
  /** Too many requests: say when to try again (`params.retryAfterSeconds`). */
  | "retry-after"
  /** A service behind the API is down: a retry state. */
  | "service-unavailable"
  /** Not signed in (or the session is no longer valid): send to sign-in. */
  | "sign-in"
  /** Show the server's message. */
  | "message";

/** Every platform code's handling. A new platform code without an entry does not compile. */
export const REFUSAL_HANDLERS = {
  "account.age_already_recorded": "message",
  "account.age_unverified": "age-gate",
  "account.consent_required": "consent-wait",
  "account.export_too_large": "message",
  "account.identity_conflict": "signed-out-erased",
  "account.not_found": "signed-out-erased",
  "account.not_provisioned": "not-provisioned",
  "account.restricted": "restricted",
  "account.child_accounts_unavailable": "message",
  "admin.config_invalid_value": "message",
  "admin.config_scope_refused": "message",
  "admin.kill_switch_failed": "message",
  "admin.operator_only": "message",
  "admin.self_target": "message",
  "admin.target_not_found": "message",
  "approvals.approver_not_allowed": "message",
  "approvals.decision_conflict": "message",
  "approvals.expired": "message",
  "approvals.indeterminate": "message",
  "approvals.hold_not_found": "message",
  "approvals.permission_required": "message",
  "approvals.run_failed": "message",
  "approvals.self_approval": "message",
  "approvals.stale": "message",
  "auth.account_exists": "message",
  "auth.challenge_failed": "message",
  "auth.code_expired": "message",
  "auth.code_invalid": "message",
  "auth.email_not_verified": "message",
  "auth.default_role_limited": "message",
  "auth.grant_exceeds_own": "message",
  "auth.guest_refused": "message",
  "auth.guest_invalid": "sign-in",
  "auth.invalid_credentials": "message",
  "auth.mfa_required": "message",
  "auth.password_policy": "message",
  "auth.permission_denied": "message",
  "auth.required": "sign-in",
  "auth.role_database_only": "message",
  "auth.role_protected": "message",
  "auth.role_self_change": "message",
  "auth.sign_in_required": "sign-in",
  "auth.signups_closed": "message",
  "auth.sso_failed": "message",
  "auth.token_invalid": "sign-in",
  "auth.too_many_attempts": "message",
  "content.rejected": "message",
  "feature.not_configured": "message",
  "guest.allowance_exhausted": "sign-in",
  "internal.error": "message",
  "jobs.not_dead": "message",
  "jobs.not_found": "message",
  "moderation.appeal_not_found": "message",
  "moderation.appeal_not_allowed": "message",
  "moderation.appeal_pending": "message",
  "moderation.appeal_reason_too_short": "message",
  "moderation.appeal_window_expired": "message",
  "moderation.decision_not_found": "message",
  "moderation.item_state_conflict": "message",
  "moderation.modified_action_required": "message",
  "moderation.not_claimer": "message",
  "moderation.not_own_decision": "message",
  "moderation.review_item_not_found": "message",
  "moderation.self_review": "message",
  "rate.limited": "retry-after",
  "request.invalid_body": "message",
  "request.json_too_deep": "message",
  "request.json_too_large": "message",
  "request.trajectory_full": "message",
  "request.trajectory_chain_full": "message",
  "request.invalid_json": "message",
  "request.field_not_accepted": "message",
  "request.invalid_value": "message",
  "request.missing_fields": "message",
  "request.text_empty": "message",
  "request.text_too_long": "message",
  "service.unavailable": "service-unavailable",
  "tenant.conflict": "message",
  "tenant.not_shared": "message",
  "tenant.not_active": "message",
  "tenant.invalid": "message",
  "tenant.not_found": "message",
  "tenant.own_tenant": "message",
  "tenant.self_approval": "message",
  "tenant.mismatch": "sign-in",
  "tenant.missing": "tenant-unavailable",
  "tenant.suspended": "tenant-unavailable",
  "tenant.unknown_host": "tenant-unavailable",
} as const satisfies Readonly<Record<PlatformErrorCode, RefusalKind>>;

/** A refused call, as a screen renders it. */
export interface Refusal {
  readonly kind: RefusalKind;
  /** The registered code, or "" when the reply carried none (a proxy's page, a network error). */
  readonly code: string;
  /** What to show: the server's message, else the catalog's, else a generic one. */
  readonly message: string;
  readonly status?: number;
  /** For "retry-after": whole seconds until a retry can succeed. */
  readonly retryAfterSeconds?: number;
  /** For "restricted": the account's status (suspended, banned, …). */
  readonly accountStatus?: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface RefusalDetail {
  readonly message?: unknown;
  readonly params?: unknown;
  readonly status?: number;
}

/** The kind of handling `code` needs. An app code, or no code, is "message". */
export function refusalKind(code: unknown): RefusalKind {
  return typeof code === "string" &&
    Object.prototype.hasOwnProperty.call(REFUSAL_HANDLERS, code)
    ? REFUSAL_HANDLERS[code as PlatformErrorCode]
    : "message";
}

function catalogMessage(code: unknown): string {
  return isErrorCode(code)
    ? renderMessage(messageKey(code as ErrorCode))
    : renderMessage("screens.refusal.generic");
}

/**
 * The Refusal for a coded reply. The server's message is used when it sent one (it is rendered
 * in the caller's language); a 5xx without one gets the catalog's text for its code.
 */
export function handleRefusal(code: unknown, detail: RefusalDetail = {}): Refusal {
  const kind = refusalKind(code);
  const params =
    detail.params && typeof detail.params === "object"
      ? (detail.params as Record<string, unknown>)
      : {};
  const message =
    typeof detail.message === "string" && detail.message.trim() !== ""
      ? detail.message
      : catalogMessage(code);
  const retry = params.retryAfterSeconds;
  const status = params.status;
  return {
    kind,
    code: typeof code === "string" ? code : "",
    message,
    params,
    ...(detail.status !== undefined ? { status: detail.status } : {}),
    ...(kind === "retry-after" && typeof retry === "number" && Number.isFinite(retry)
      ? { retryAfterSeconds: Math.max(0, Math.ceil(retry)) }
      : {}),
    ...(kind === "restricted" && typeof status === "string"
      ? { accountStatus: status }
      : {}),
  };
}

/** The Refusal a refused Response carries (its body read from a copy; never throws). */
export async function readRefusal(res: Response): Promise<Refusal> {
  let body: { code?: unknown; message?: unknown; error?: unknown; params?: unknown } = {};
  try {
    const copy = typeof res.clone === "function" ? res.clone() : res;
    const parsed = (await copy.json()) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as typeof body;
  } catch {
    // Not JSON (a proxy's error page): no code — the generic message.
  }
  return handleRefusal(body.code, {
    message: typeof body.message === "string" ? body.message : body.error,
    params: body.params,
    status: res.status,
  });
}

/** The Refusal for a request that never got an answer. */
export function networkRefusal(): Refusal {
  return {
    kind: "service-unavailable",
    code: "",
    message: renderMessage("screens.refusal.network"),
    params: {},
  };
}

/** How many times, and how long apart, a request is retried while the account is set up. */
export const PROVISIONING_RETRY = Object.freeze({ attempts: 3, baseDelayMs: 500 });

/** The wait before retry `attempt` (1-based): 0.5 s, 1 s, 2 s, … */
export function retryDelayMs(
  attempt: number,
  baseDelayMs = PROVISIONING_RETRY.baseDelayMs
) {
  return baseDelayMs * 2 ** Math.max(0, attempt - 1);
}

async function isNotProvisioned(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  return (await readRefusal(res)).kind === "not-provisioned";
}

/**
 * `send()` again, with backoff, while it is refused `account.not_provisioned` (the account's
 * platform record is still being created) — at most PROVISIONING_RETRY.attempts more times. The
 * last response is returned as it came, for the caller's own handling.
 */
export async function fetchWithProvisioningRetry(
  send: () => Promise<Response>,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<Response> {
  const attempts = options.attempts ?? PROVISIONING_RETRY.attempts;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let res = await send();
  for (let attempt = 1; attempt <= attempts && (await isNotProvisioned(res)); attempt++) {
    await sleep(retryDelayMs(attempt));
    res = await send();
  }
  return res;
}

/** The window event announcing that the session must end (kind "signed-out-erased"). */
export const SESSION_END_EVENT = "platform:session-end";

/** Ask the screen holding the session to end it and show sign-in with `code`'s message. */
export function announceSessionEnd(code: string): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SESSION_END_EVENT, { detail: { code } }));
  }
}
