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

import { shown, type ShownText } from "@/platform/errors/shown-text";
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
  getTenantDirectoryStore,
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
    | "sessions"
    | "client_secret"
    | "dual_control";
  readonly state: CheckState;
  /** What the check found, as the catalog's key and values (TASK-206, N-102). */
  readonly detail: ShownText;
}

export interface TenancyReadiness {
  readonly mode: "single" | "shared";
  readonly tenantId?: string;
  readonly ready: boolean;
  readonly checks: readonly ReadinessCheck[];
}

async function databaseCheck(): Promise<ReadinessCheck> {
  if (!hasDatabase()) {
    return {
      name: "database",
      state: "not_ready",
      detail: shown("screens.readiness.database_unset"),
    };
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
        detail: shown("screens.readiness.database_role_missing"),
      };
    if (r.bypass || r.superuser) {
      return {
        name: "database",
        state: "not_ready",
        detail: shown("screens.readiness.database_bypasses_rls", { role: r.role }),
      };
    }
    return {
      name: "database",
      state: "ready",
      detail: shown("screens.readiness.database_ready", { role: r.role }),
    };
  } catch (err) {
    logCaught(logger, "Readiness: the database could not be reached", err, {
      route: "platform/tenancy/readiness",
    });
    return {
      name: "database",
      state: "not_ready",
      detail: shown("screens.readiness.database_unreachable"),
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
      detail: shown("screens.readiness.erasure_not_needed"),
    };
  }
  const r = await provider.checkErasureAccess();
  if (r.state === "ready") {
    return {
      name: "erasure",
      state: "ready",
      detail: shown("screens.readiness.erasure_ready"),
    };
  }
  return {
    name: "erasure",
    state: r.state === "unknown" ? "unknown" : "not_ready",
    detail: shown("screens.readiness.erasure_not_ready", { reason: r.reason }),
  };
}

/**
 * Whether the provider's administrative key can do what server-side sessions ask of it (ADR-057
 * D7): read a user, sign one out everywhere, turn a second factor off. Not ready is a degraded
 * deployment, not a broken one — sign-in and sign-out still work — and the detail names the
 * missing action or key.
 */
async function sessionsCheck(
  provider: AuthProvider | undefined
): Promise<ReadinessCheck> {
  if (!provider?.checkSessionAccess) {
    return {
      name: "sessions",
      state: "not_needed",
      detail: shown("screens.readiness.sessions_not_needed"),
    };
  }
  const r = await provider.checkSessionAccess();
  if (r.state === "ready") {
    return {
      name: "sessions",
      state: "ready",
      detail: shown("screens.readiness.sessions_ready"),
    };
  }
  return {
    name: "sessions",
    state: r.state === "unknown" ? "unknown" : "not_ready",
    detail: shown("screens.readiness.sessions_not_ready", { reason: r.reason }),
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
      detail: shown("screens.readiness.secret_not_needed"),
    };
  }
  const r = await provider.checkClientSecret();
  if (r.state === "ready") {
    return {
      name: "client_secret",
      state: "ready",
      detail: shown("screens.readiness.secret_ready"),
    };
  }
  return {
    name: "client_secret",
    state: r.state === "mismatch" ? "not_ready" : "unknown",
    detail: shown("screens.readiness.secret_not_ready", { reason: r.reason }),
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
      ? shown("screens.readiness.mode_shared")
      : shown("screens.readiness.mode_single", { tenant: settings.tenantId ?? "" }),
  });

  checks.push(await databaseCheck());

  checks.push(
    getDatabaseSettings().ownerUrl
      ? {
          name: "owner_connection",
          state: "ready",
          detail: shown("screens.readiness.owner_ready"),
        }
      : {
          name: "owner_connection",
          state: "not_ready",
          detail: shown("screens.readiness.owner_unset"),
        }
  );

  // As boot chose it (TASK-206, N-103): Postgres whenever there is a database.
  const directory = getTenantDirectoryStore();
  checks.push(
    directory === "postgres"
      ? {
          name: "directory",
          state: "ready",
          detail: shown("screens.readiness.directory_ready"),
        }
      : shared
        ? {
            name: "directory",
            state: "not_ready",
            detail: shown("screens.readiness.directory_shared_memory"),
          }
        : {
            name: "directory",
            state: "not_needed",
            detail: shown("screens.readiness.directory_memory"),
          }
  );

  if (!shared) {
    checks.push({
      name: "identity",
      state: "not_needed",
      detail: shown("screens.readiness.identity_single"),
    });
  } else if (!getCognitoAdminCredentials()) {
    checks.push({
      name: "identity",
      state: "not_ready",
      detail: shown("screens.readiness.identity_no_key"),
    });
  } else {
    const provider = providerOrNone();
    const result = provider?.checkTenantAttribute
      ? await provider.checkTenantAttribute()
      : {
          state: "unknown" as const,
          reason: shown("screens.readiness.identity_unreportable"),
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
          ? shown("screens.readiness.identity_ready")
          : shown("screens.readiness.identity_not_ready", { reason: result.reason }),
    });
  }

  const provider = providerOrNone();
  const [erasure, sessions, clientSecret, dual] = await Promise.all([
    erasureCheck(provider),
    sessionsCheck(provider),
    clientSecretCheck(provider),
    checkDualControlReadiness(options.heldActions),
  ]);
  checks.push(erasure, sessions, clientSecret, {
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
