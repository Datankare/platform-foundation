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
 * `account_created` audit entry. It is idempotent and race-safe — the insert ignores a row that
 * already exists, so two first requests at once create one row — and it never changes an
 * existing row (a banned user stays banned).
 *
 * GenAI Principles: P11 (fail-closed — a provisioning failure is reported, never treated as
 * allowed), P13 (governance — the default role is a seeded role, not code-defined permissions)
 *
 * @module platform/auth
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { getSupabaseUrl } from "@/platform/providers/environment-contract";
import { writeAuditLog } from "@/platform/auth/audit";

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

type Result<T> = Promise<{ data: T | null; error: { message: string } | null }>;

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
  if (!getSupabaseUrl()) return "skipped";
  if (!UUID_PATTERN.test(userId))
    return fail(userId, "validate", "not a provider subject");

  try {
    const supabase = getSupabaseServiceClient();

    const existing = await (supabase
      .from("users" as never)
      .select("id")
      .eq("id", userId)
      .maybeSingle() as unknown as Result<{ id: string }>);
    if (existing.error) return fail(userId, "read", existing.error.message);
    if (existing.data) return "existing";

    const role = await (supabase
      .from("roles" as never)
      .select("id")
      .eq("name", DEFAULT_USER_ROLE)
      .maybeSingle() as unknown as Result<{ id: string }>);
    if (role.error) return fail(userId, "role", role.error.message);
    if (!role.data)
      return fail(userId, "role", `default role "${DEFAULT_USER_ROLE}" is missing`);

    const email = profile.email?.trim() ? profile.email.trim().toLowerCase() : null;
    const inserted = await (supabase
      .from("users" as never)
      .upsert(
        {
          id: userId,
          cognito_sub: userId,
          email,
          email_verified: profile.emailVerified === true,
          role_id: role.data.id,
        } as never,
        { onConflict: "id", ignoreDuplicates: true }
      )
      .select("id") as unknown as Result<{ id: string }[]>);
    if (inserted.error) return fail(userId, "insert", inserted.error.message);

    // Empty result: another request created it between the read and the insert.
    if (!inserted.data || inserted.data.length === 0) return "existing";

    logger.info("User provisioned", {
      userId,
      role: DEFAULT_USER_ROLE,
      route: "platform/auth/user-provisioning",
    });
    void writeAuditLog({
      action: "account_created",
      actorId: userId,
      targetId: userId,
      details: { role: DEFAULT_USER_ROLE, via: "first_authenticated_request" },
    });
    return "created";
  } catch (err) {
    return fail(userId, "exception", err);
  }
}
