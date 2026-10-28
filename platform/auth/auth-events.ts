/**
 * platform/auth/auth-events.ts — Authentication events in the audit log (audit A-12)
 *
 * Sign-ins, failed sign-ins, sign-outs, password resets and MFA changes were never recorded, so
 * an account taken over, or an address trying passwords, left no trace in the audit log. Each
 * auth route now records its event through recordAuthEvent:
 *
 *   - a session is handed out only once its `login_success` record is written (no record, no
 *     session — Adversarial Validation practice 6);
 *   - a failure (`login_failed`) is recorded best effort: the refusal stands either way;
 *   - the network address and user agent are recorded with each event, the address only when it
 *     is one (a missing or forged header never reaches the inet column).
 *
 * No email address or password is ever recorded: the actor is the account's id, when known.
 * Without a database (mock and CI runs) nothing persists, and nothing is refused for it.
 *
 * The last sign-in (TASK-185): each sign-in that hands out a session (password, MFA, new
 * password, SSO — not a refresh, which is the same session going on) also sets the account's
 * users.last_login_at, best effort — one indexed update per sign-in; a failure is logged and the
 * session stands. A first sign-in comes before the account's row exists: provisioning takes the
 * time from this event's record (user-provisioning.ts). Migration 057 fills the column from the
 * records kept before this.
 *
 * @module platform/auth
 */

import { isIP } from "node:net";
import { hasDatabase, withTenantTx } from "@/platform/data";
import { logger } from "@/lib/logger";
import { recordAudit, type AuditEntry } from "@/platform/auth/audit";
import { getClientIp } from "@/platform/rate-limit/client-ip";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A user id when `value` is one; anything else is not recorded as an actor. */
export function auditableUserId(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value : undefined;
}

interface RequestLike {
  readonly headers: Headers;
}

/** Where the request came from, in the shape the audit columns accept. */
export function requestOrigin(request: RequestLike): {
  ipAddress?: string;
  userAgent?: string;
} {
  const ip = getClientIp(request);
  const userAgent = request.headers.get("user-agent")?.slice(0, 256);
  return {
    ...(isIP(ip) ? { ipAddress: ip } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

/**
 * Record an authentication event. True when it was recorded (or there is no database to record
 * it in); false when the record could not be written — recordAudit has logged why.
 */
export async function recordAuthEvent(
  entry: AuditEntry,
  request: RequestLike
): Promise<boolean> {
  if (!hasDatabase()) return true;
  try {
    await recordAudit({ ...entry, ...requestOrigin(request) });
    return true;
  } catch {
    return false;
  }
}

/** How a session was obtained that counts as signing in (a refresh does not). */
const SIGN_IN_METHODS: ReadonlySet<string> = new Set([
  "password",
  "mfa",
  "new_password",
  "sso",
]);

/**
 * Set the account's last sign-in (users.last_login_at) to now, for a sign-in by `method`. Best
 * effort, never throws; nothing for a refresh, an unknown account, or no database.
 */
export async function recordLastSignIn(
  accountId: string | undefined,
  method: string
): Promise<void> {
  if (!accountId || !SIGN_IN_METHODS.has(method) || !hasDatabase()) return;
  try {
    await withTenantTx((tx) =>
      tx.query(
        "update users set last_login_at = now() where id = $1::uuid and deleted_at is null",
        [accountId]
      )
    );
  } catch (err) {
    logger.warn("The account's last sign-in could not be recorded", {
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/auth-events",
    });
  }
}
