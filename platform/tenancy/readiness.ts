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
 *   erasure       (every mode, N-22) erasure can delete identities: the administrative key is set
 *                 and the pool allows the lookup by subject and the delete (a refused probe of a
 *                 user that cannot exist — nothing is deleted)
 *   client_secret (every mode, N-52) the app client's secret the deployment holds is the pool's —
 *                 read with the administrative key and compared in constant time, never a
 *                 sign-in (the owner's decision is recorded in TASK-203)
 *   dual_control  (every mode, N-24) every dual-controlled action has a second account that may
 *                 approve it; each one without is named (platform/admin/dual-control-readiness.ts)
 *
 * Read-only; safe to run at any time.
 *
 * @module platform/tenancy
 */

import { getAuthProvider } from "@/platform/auth/config";
import { logCaught } from "@/platform/observability/caught-error";
import { logger } from "@/lib/logger";
import type { AuthProvider } from "@/platform/auth/provider";
import {
  checkDualControlReadiness,
  type DualControlledAction,
} from "@/platform/admin/dual-control-readiness";
import { hasDatabase, withPlatformTx } from "@/platform/data";
import {
  getCognitoAdminCredentials,
  getDatabaseSettings,
  getTenancySettings,
  getTenantDirectoryStoreSetting,
} from "@/platform/providers/environment-contract";

export type CheckState = "ready" | "not_ready" | "not_needed" | "unknown";

export interface ReadinessCheck {
  readonly name:
    | "mode"
    | "database"
    | "owner_connection"
    | "directory"
    | "identity"
    | "erasure"
    | "client_secret"
    | "dual_control";
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
    logCaught(logger, "Readiness: the database could not be reached", err, {
      route: "platform/tenancy/readiness",
    });
    return {
      name: "database",
      state: "not_ready",
      detail: "The database could not be reached (the detail is in the log).",
    };
  }
}

/** The registered auth provider, or undefined when none can be built. */
function providerOrNone(): AuthProvider | undefined {
  try {
    return getAuthProvider();
  } catch {
    return undefined;
  }
}

/** Whether erasure can delete identities from the provider's pool (N-22), in every mode. */
async function erasureCheck(provider: AuthProvider | undefined): Promise<ReadinessCheck> {
  if (!provider?.checkErasureAccess) {
    return {
      name: "erasure",
      state: "not_needed",
      detail: "The identity provider keeps no identities the platform erases.",
    };
  }
  const r = await provider.checkErasureAccess();
  if (r.state === "ready") {
    return {
      name: "erasure",
      state: "ready",
      detail: "Erasure can find an identity by its subject and delete it.",
    };
  }
  return {
    name: "erasure",
    state: r.state === "unknown" ? "unknown" : "not_ready",
    detail: `Erasure cannot delete identities: ${r.reason}.`,
  };
}

/** Whether the app client's secret the deployment holds is the pool's (N-52). */
async function clientSecretCheck(
  provider: AuthProvider | undefined
): Promise<ReadinessCheck> {
  if (!provider?.checkClientSecret) {
    return {
      name: "client_secret",
      state: "not_needed",
      detail: "The identity provider has no app client secret to check.",
    };
  }
  const r = await provider.checkClientSecret();
  if (r.state === "ready") {
    return {
      name: "client_secret",
      state: "ready",
      detail: "The app client's secret is the one the pool has.",
    };
  }
  return {
    name: "client_secret",
    state: r.state === "mismatch" ? "not_ready" : "unknown",
    detail: `The app client's secret is not confirmed: ${r.reason}.`,
  };
}

export interface TenancyReadinessOptions {
  /**
   * The app's own dual-controlled actions, weighed with the platform's (the routes pass PF's
   * command bar: commandBarDualControlledActions).
   */
  readonly heldActions?: () => Promise<readonly DualControlledAction[]>;
}

export async function checkTenancyReadiness(
  options: TenancyReadinessOptions = {}
): Promise<TenancyReadiness> {
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
    const provider = providerOrNone();
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

  const provider = providerOrNone();
  const [erasure, clientSecret, dual] = await Promise.all([
    erasureCheck(provider),
    clientSecretCheck(provider),
    checkDualControlReadiness(options.heldActions),
  ]);
  checks.push(erasure, clientSecret, {
    name: "dual_control",
    state: dual.state,
    detail: dual.detail,
  });

  return {
    mode: settings.mode,
    ...(settings.mode === "single" ? { tenantId: settings.tenantId } : {}),
    ready: checks.every((c) => c.state === "ready" || c.state === "not_needed"),
    checks,
  };
}
