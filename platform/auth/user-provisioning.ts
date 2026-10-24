/**
 * platform/auth/user-provisioning.ts — Create the platform's user row on first use (TASK-117)
 *
 * Sign-up creates the identity in the auth provider (Cognito) only. Every platform check that
 * follows — account status, COPPA, permissions, data export, RLS — reads the user's row in
 * `users`, keyed by the provider's subject (`id = cognito_sub = sub`). Nothing created that row,
 * so on a new database every new account was refused (the guard read no row as a DB error and
 * failed closed as "banned").
 *
 * ensureUserProvisioned() creates the row the first time an authenticated user reaches a
 * guarded route: default role (DEFAULT_USER_ROLE), defaults for everything else, an
 * `account_created` audit entry, written before the row (no entry, no row: `failed`). It is
 * idempotent and race-safe — the insert ignores a row that already exists, so two first
 * requests at once create one row — and it never changes an existing row (a banned user stays
 * banned).
 *
 * The row is written in the request's tenant (platform/data, ADR-053 D4): users.tenant_id is
 * filled by the column default and row-level security limits the read to that tenant.
 *
 * GenAI Principles: P11 (fail-closed — a provisioning failure is reported, never treated as
 * allowed), P13 (governance — the default role is a seeded role, not code-defined permissions)
 *
 * @module platform/auth
 */

import { hasDatabase, withTenantTx } from "@/platform/data";
import { logger } from "@/lib/logger";
import { AuditWriteError, audited } from "@/platform/auth/audit";

/** The role every new account starts with (seeded by the schema baseline). */
export const DEFAULT_USER_ROLE = "free";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the caller knows about the user from their verified token, if anything. */
export interface ProvisioningProfile {
  readonly email?: string;
  readonly emailVerified?: boolean;
}

/**
 * - `existing`  — the row was already there (nothing changed);
 * - `created`   — this call created it;
 * - `skipped`   — no database is configured (mock/CI), so there is nothing to provision;
 * - `failed`    — the row could not be read or created; the caller must not allow the request.
 */
export type ProvisioningOutcome = "existing" | "created" | "skipped" | "failed";

function fail(userId: string, step: string, error: unknown): ProvisioningOutcome {
  logger.error("User provisioning failed", {
    userId,
    step,
    error: error instanceof Error ? error.message : String(error),
    route: "platform/auth/user-provisioning",
  });
  return "failed";
}

export async function ensureUserProvisioned(
  userId: string,
  profile: ProvisioningProfile = {}
): Promise<ProvisioningOutcome> {
  if (!hasDatabase()) return "skipped";
  if (!UUID_PATTERN.test(userId))
    return fail(userId, "validate", "not a provider subject");

  try {
    let roleId: string;
    try {
      const found = await withTenantTx(async (tx) => {
        const existing = await tx.query("select id from users where id = $1::uuid", [
          userId,
        ]);
        if (existing.rows.length > 0) return { existing: true as const };
        // The role catalog is platform-owned and readable from any tenant.
        const role = await tx.query<{ id: string }>(
          "select id from roles where name = $1",
          [DEFAULT_USER_ROLE]
        );
        return { existing: false as const, roleId: role.rows[0]?.id };
      });
      if (found.existing) return "existing";
      if (!found.roleId)
        return fail(userId, "role", `default role "${DEFAULT_USER_ROLE}" is missing`);
      roleId = found.roleId;
    } catch (err) {
      return fail(userId, "read", err);
    }

    const email = profile.email?.trim() ? profile.email.trim().toLowerCase() : null;
    // Recorded before the account is created; no record, no account (Adversarial Validation, 6).
    // Two concurrent first requests each record an attempt; only one creates the row.
    let inserted: { created: boolean; error?: string };
    try {
      inserted = await audited(
        {
          action: "account_created",
          actorId: userId,
          targetId: userId,
          details: { role: DEFAULT_USER_ROLE, via: "first_authenticated_request" },
        },
        async () => {
          try {
            const { rows } = await withTenantTx((tx) =>
              tx.query(
                `insert into users (id, cognito_sub, email, email_verified, role_id)
                 values ($1::uuid, $2, $3, $4, $5::uuid)
                 on conflict (id) do nothing
                 returning id`,
                [userId, userId, email, profile.emailVerified === true, roleId]
              )
            );
            return { created: rows.length > 0 };
          } catch (err) {
            return {
              created: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      );
    } catch (err) {
      if (err instanceof AuditWriteError) return fail(userId, "audit", err);
      throw err;
    }
    if (inserted.error !== undefined) return fail(userId, "insert", inserted.error);

    // Nothing inserted: another request created it between the read and the insert.
    if (!inserted.created) return "existing";

    logger.info("User provisioned", {
      userId,
      role: DEFAULT_USER_ROLE,
      route: "platform/auth/user-provisioning",
    });
    return "created";
  } catch (err) {
    return fail(userId, "exception", err);
  }
}
