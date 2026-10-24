/**
 * platform/tenancy/readiness.ts — is this deployment set up to keep tenants apart? (ADR-053)
 *
 * What the operator console shows before tenants are trusted to it, each check with a plain
 * reason when it fails:
 *
 *   mode          single or shared, and the tenant a single deployment serves
 *   database      a request connection that is not the owner and cannot bypass row-level
 *                 security, and an owner connection for operator paths
 *   directory     where tenants are kept (a shared deployment needs Postgres)
 *   identity      (shared) the identity provider holds each user's tenant where users cannot
 *                 change it, and the platform can set it
 *
 * Read-only; safe to run at any time.
 *
 * @module platform/tenancy
 */

import { getAuthProvider } from "@/platform/auth/config";
import { hasDatabase, withPlatformTx } from "@/platform/data";
import {
  getCognitoAdminCredentials,
  getDatabaseSettings,
  getTenancySettings,
  getTenantDirectoryStoreSetting,
} from "@/platform/providers/environment-contract";

export type CheckState = "ready" | "not_ready" | "not_needed" | "unknown";

export interface ReadinessCheck {
  readonly name: "mode" | "database" | "owner_connection" | "directory" | "identity";
  readonly state: CheckState;
  readonly detail: string;
}

export interface TenancyReadiness {
  readonly mode: "single" | "shared";
  readonly tenantId?: string;
  readonly ready: boolean;
  readonly checks: readonly ReadinessCheck[];
}

async function databaseCheck(): Promise<ReadinessCheck> {
  if (!hasDatabase()) {
    return { name: "database", state: "not_ready", detail: "DATABASE_URL is not set." };
  }
  try {
    const { rows } = await withPlatformTx((tx) =>
      tx.query<{ role: string; bypass: boolean; superuser: boolean }>(
        `select current_user as role, r.rolbypassrls as bypass, r.rolsuper as superuser
           from pg_roles r where r.rolname = current_user`
      )
    );
    const r = rows[0];
    if (!r)
      return {
        name: "database",
        state: "unknown",
        detail: "The connection's role was not found.",
      };
    if (r.bypass || r.superuser) {
      return {
        name: "database",
        state: "not_ready",
        detail: `The request connection signs in as ${r.role}, which bypasses row-level security; it must be app_tenant.`,
      };
    }
    return {
      name: "database",
      state: "ready",
      detail: `The request connection signs in as ${r.role}, under row-level security.`,
    };
  } catch (err) {
    return {
      name: "database",
      state: "not_ready",
      detail: `The database could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function checkTenancyReadiness(): Promise<TenancyReadiness> {
  const settings = getTenancySettings();
  const shared = settings.mode === "shared";
  const checks: ReadinessCheck[] = [];

  checks.push({
    name: "mode",
    state: "ready",
    detail: shared
      ? "Shared: each request's tenant comes from the verified identity, or its address."
      : `Single: this deployment serves tenant ${settings.tenantId}.`,
  });

  checks.push(await databaseCheck());

  checks.push(
    getDatabaseSettings().ownerUrl
      ? {
          name: "owner_connection",
          state: "ready",
          detail: "DATABASE_OWNER_URL is set for operator paths.",
        }
      : {
          name: "owner_connection",
          state: "not_ready",
          detail:
            "DATABASE_OWNER_URL is not set: platform defaults and tenant lifecycle cannot run.",
        }
  );

  const directory = getTenantDirectoryStoreSetting();
  checks.push(
    directory === "postgres"
      ? { name: "directory", state: "ready", detail: "Tenants are kept in Postgres." }
      : shared
        ? {
            name: "directory",
            state: "not_ready",
            detail: "A shared deployment needs TENANT_DIRECTORY_STORE=postgres.",
          }
        : {
            name: "directory",
            state: "not_needed",
            detail:
              "Tenants are kept per instance (memory); a single deployment does not need more.",
          }
  );

  if (!shared) {
    checks.push({
      name: "identity",
      state: "not_needed",
      detail: "A single deployment's users all belong to its one tenant.",
    });
  } else if (!getCognitoAdminCredentials()) {
    checks.push({
      name: "identity",
      state: "not_ready",
      detail:
        "COGNITO_ADMIN_ACCESS_KEY_ID is not set: new users cannot be assigned a tenant.",
    });
  } else {
    let provider;
    try {
      provider = getAuthProvider();
    } catch {
      provider = undefined;
    }
    const result = provider?.checkTenantAttribute
      ? await provider.checkTenantAttribute()
      : {
          state: "unknown" as const,
          reason: "the identity provider cannot report on tenants",
        };
    checks.push({
      name: "identity",
      state:
        result.state === "ready"
          ? "ready"
          : result.state === "unknown"
            ? "unknown"
            : "not_ready",
      detail:
        result.state === "ready"
          ? "Users' tenants are held by the identity provider, readable and not writable by users."
          : `Users' tenants are not held safely: ${result.reason}.`,
    });
  }

  return {
    mode: settings.mode,
    ...(settings.mode === "single" ? { tenantId: settings.tenantId } : {}),
    ready: checks.every((c) => c.state === "ready" || c.state === "not_needed"),
    checks,
  };
}
