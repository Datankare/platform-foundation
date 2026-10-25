/**
 * platform/tenancy/identity.ts — a new identity joins the tenant it signed up at (ADR-053 D2)
 *
 * In a shared deployment a user's tenant is held by the identity provider (Cognito
 * `custom:tenant_id`), which users cannot change. It is set by the platform:
 *
 *   sign-up       the account is created, then assigned the tenant of the address it was
 *                 created at — if that tenant accepts new accounts (signups_enabled)
 *   sign-in, SSO  an identity with no tenant yet is assigned one:
 *                   - an existing account (a users row for the identity, from before the
 *                     deployment was shared) keeps its own tenant — never the address's; at
 *                     another tenant's address it is refused, so moving a deployment from single
 *                     to shared cannot hand an existing account to whichever tenant it signs in
 *                     at first, and closed sign-ups never lock an existing account out
 *                   - a new identity (a federated first sign-in, or a sign-up whose assignment
 *                     failed) is assigned the address's tenant, if it accepts new accounts
 *                 one that belongs to another tenant is refused (tenant.mismatch) and receives
 *                 no session
 *
 * A single-tenant deployment needs none of this: every identity is its one tenant.
 *
 * @module platform/tenancy
 */

import type { NextResponse } from "next/server";
import { getAuthProvider } from "@/platform/auth/config";
import { getConfigBoolean, getConfigOrThrow } from "@/platform/auth/platform-config";
import { hasDatabase, withOwnerTx } from "@/platform/data";
import { apiError } from "@/platform/errors";
import { logger } from "@/lib/logger";
import {
  forgetTokenVerification,
  revokeTokenVerification,
} from "@/platform/auth/token-verification";
import { peekTenant } from "./context";

export type IdentityTenantRefusal =
  "tenant.mismatch" | "auth.signups_closed" | "service.unavailable";

export type IdentityTenantOutcome =
  { readonly ok: true } | { readonly ok: false; readonly code: IdentityTenantRefusal };

/**
 * Whether the current tenant accepts new accounts — fail closed: with a database, a value that
 * cannot be read (the database down, the key missing) or is anything but true means no.
 * getConfig would answer its default for an unreadable value, so it is not used here. Without
 * a database (local runs, the E2E in-memory harness) there is no stored setting, and sign-ups
 * are open.
 */
export async function signupsOpen(): Promise<boolean> {
  if (!hasDatabase()) return getConfigBoolean("signups_enabled", true);
  try {
    const value = await getConfigOrThrow<unknown>("signups_enabled");
    return value === true || value === "true";
  } catch (err) {
    logger.error("signups_enabled unreadable — sign-ups refused (fail closed)", {
      route: "platform/tenancy/identity",
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * The tenants that already hold an account for this identity (users.cognito_sub). Read through
 * the owner connection: the account may be in any tenant, and that is what is being asked.
 */
async function accountTenants(subject: string): Promise<string[]> {
  const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
    tx.query<{ tenant_id: string }>(
      "select distinct tenant_id from users where cognito_sub = $1",
      [subject]
    )
  );
  return rows.map((r) => r.tenant_id);
}

/** Assign the current tenant to a new user; false when it could not be done. */
export async function assignCurrentTenant(userId: string): Promise<boolean> {
  const tenant = peekTenant();
  if (tenant?.mode !== "shared") return true;
  const provider = getAuthProvider();
  if (!provider.assignTenant) {
    logger.error(
      "The auth provider cannot assign tenants; a shared deployment needs it",
      {
        route: "platform/tenancy/identity",
      }
    );
    return false;
  }
  const r = await provider.assignTenant(userId, tenant.tenantId);
  if (!r.success) {
    logger.error("Assigning a new user's tenant failed", {
      route: "platform/tenancy/identity",
      error: r.error,
    });
    return false;
  }
  // A verification remembered before the assignment carries no tenant (review 8 M1: the new
  // user's requests were refused tenant.missing until the entry aged out, ~30 s). Every token of
  // the user is verified again, on every instance, and so reads the tenant just written.
  await revokeTokenVerification(userId);
  return true;
}

/**
 * After a successful sign-in or SSO exchange: the identity behind `accessToken` belongs to the
 * request's tenant, or is made to (a new identity, where sign-ups are open), or is refused.
 */
export async function ensureIdentityTenant(
  accessToken: string
): Promise<IdentityTenantOutcome> {
  const tenant = peekTenant();
  if (tenant?.mode !== "shared") return { ok: true };

  let payload;
  try {
    payload = await getAuthProvider().verifyToken(accessToken);
  } catch {
    payload = null;
  }
  if (!payload) return { ok: false, code: "service.unavailable" };

  if (payload.tenantId !== undefined) {
    return payload.tenantId === tenant.tenantId
      ? { ok: true }
      : { ok: false, code: "tenant.mismatch" };
  }
  let homes: string[];
  try {
    homes = await accountTenants(payload.sub);
  } catch (err) {
    logger.error("Could not look up the identity's existing account", {
      route: "platform/tenancy/identity",
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "service.unavailable" };
  }
  if (homes.length > 0) {
    // An existing account: its tenant is where its data is, not where it signs in.
    if (!homes.includes(tenant.tenantId)) return { ok: false, code: "tenant.mismatch" };
  } else if (!(await signupsOpen())) {
    return { ok: false, code: "auth.signups_closed" };
  }
  if (!(await assignCurrentTenant(payload.sub)))
    return { ok: false, code: "service.unavailable" };
  // This token's own entry, verified above without the tenant, goes too (M1).
  await forgetTokenVerification(accessToken);
  return { ok: true };
}

/**
 * For a route about to return a provider's result: null when the result may be returned, or the
 * refusal to return instead. Any result that carries a session (an access, refresh or ID token)
 * must pass ensureIdentityTenant first — sign-in, SSO, and the challenge steps that end in a
 * session (MFA, new password). A session with no access token to check is refused: what cannot
 * be checked is not handed out.
 */
export async function sessionTenantRefusal(
  result: {
    readonly success: boolean;
    readonly accessToken?: string;
    readonly refreshToken?: string;
    readonly idToken?: string;
  },
  request: { readonly headers: Headers }
): Promise<NextResponse | null> {
  if (!result.success) return null;
  if (!result.accessToken && !result.refreshToken && !result.idToken) return null;
  const joined: IdentityTenantOutcome = result.accessToken
    ? await ensureIdentityTenant(result.accessToken)
    : peekTenant()?.mode === "shared"
      ? { ok: false, code: "service.unavailable" }
      : { ok: true };
  if (joined.ok) return null;
  return joined.code === "service.unavailable"
    ? apiError("service.unavailable", { params: { service: "tenants" }, request })
    : apiError(joined.code, { request });
}
