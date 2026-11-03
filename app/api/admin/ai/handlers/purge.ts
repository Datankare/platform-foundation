/**
 * app/api/admin/ai/handlers/purge.ts — an account's irreversible erasure, as a governed action
 * (TASK-194, audit C-6)
 *
 * POST /api/admin/gdpr erased an account at once for one holder of admin_purge_user_data, while a
 * reversible role change needed a second admin. The erasure is now always held (command-bar.ts,
 * ALWAYS_HELD_ACTIONS): the route proposes it, a second admin who holds admin_purge_user_data —
 * and is neither the requester nor the account erased — approves it in Approvals, and it then
 * runs once, as its requester (re-verified then). A dry run changes nothing and still answers at
 * once. A user's own deletion of their account (/api/account/delete) is not this path.
 *
 * The rules, for the requester and for the approver alike (checkPurgeUserData): not one's own
 * account, not a protected role's (super_admin is changed only in the database), and the account
 * must be a user of the current tenant (ADR-053 D5), a soft-deleted one included.
 */

import { withTenantTx } from "@/platform/data";
import { findRole } from "@/platform/auth/role-lookup";
import { PROTECTED_ROLES, type VerifiedAdmin } from "@/platform/auth/role-governance";
import { createPlatformPurgePipeline } from "@/platform/gdpr";
import type { PurgeRequest, PurgeResult } from "@/platform/gdpr";
import { PURGE_REASONS as LISTED_PURGE_REASONS } from "@/platform/gdpr/types";
import {
  applyRule,
  coded,
  runAudited,
  type ActionResult,
  type ApproverRule,
} from "./shared";
import { sameId } from "@/platform/auth/same-id";

/* eslint-disable @typescript-eslint/no-explicit-any */

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The reasons an erasure may be recorded under (platform/gdpr/types.ts). */
export const PURGE_REASONS: readonly PurgeRequest["reason"][] = LISTED_PURGE_REASONS;

/** Why the input is not an erasure request, or null: a user id and a listed reason. */
export function purgeInputProblem(input: Record<string, any>): ActionResult | null {
  if (typeof input.userId !== "string" || !USER_ID.test(input.userId)) {
    return coded("request.invalid_value", { field: "userId", allowed: ["a user id"] });
  }
  if (!PURGE_REASONS.includes(input.reason)) {
    return coded("request.invalid_value", {
      field: "reason",
      allowed: [...PURGE_REASONS],
    });
  }
  return null;
}

type Target = { readonly roleName: string | null } | null;

/** The account, in this tenant only (deleted accounts included), with its role's name. */
async function targetOf(userId: string): Promise<Target> {
  return withTenantTx(async (tx) => {
    const { rows } = await tx.query<{ role_id: string | null }>(
      "select role_id from users where id = $1::uuid",
      [userId]
    );
    if (!rows[0]) return null;
    const role = rows[0].role_id ? await findRole(tx, { id: rows[0].role_id }) : null;
    return { roleName: role?.name ?? null };
  });
}

function notFound(): ActionResult {
  return {
    success: false,
    error: "admin.target_not_found",
    code: "admin.target_not_found",
    params: { target: "user" },
  };
}

/**
 * The erasure's rules for `admin` — the requester when it is asked for, an approver when it is
 * approved (audit C-2: an approver satisfies the change's own rules): not their own account, nor a
 * protected role's. The coded refusal, or null; a read error throws (fail closed).
 */
function decidePurgeUserData(
  input: Record<string, any>,
  target: Target | undefined,
  admin: VerifiedAdmin
): ActionResult | null {
  const self = selfTarget(input, admin);
  if (self) return self;
  if (typeof input.userId !== "string" || !USER_ID.test(input.userId)) return null;
  if (target?.roleName && PROTECTED_ROLES.includes(target.roleName)) {
    return {
      success: false,
      error: "auth.role_protected",
      code: "auth.role_protected",
      params: { role: target.roleName },
    };
  }
  return null;
}

/** Not one's own account: decided before the account is read (round 11, nit 5). */
function selfTarget(
  input: Record<string, any>,
  admin: VerifiedAdmin
): ActionResult | null {
  return sameId(input.userId, admin.userId)
    ? { success: false, error: "admin.self_target", code: "admin.self_target" }
    : null;
}

export const purgeUserDataRule: ApproverRule<Target | undefined> = {
  beforeFacts: selfTarget,
  // The account and its role (no admin in it); an input that names no account reads nothing.
  facts: async (input) =>
    typeof input.userId === "string" && USER_ID.test(input.userId)
      ? targetOf(input.userId)
      : undefined,
  decide: decidePurgeUserData,
};

export function checkPurgeUserData(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult | null> {
  return applyRule(purgeUserDataRule, input, admin);
}

/** The pipeline's answer, for the route to return: on a run it decided, the whole result. */
export type PurgeActionResult = ActionResult & { readonly purge?: PurgeResult };

/**
 * Erase (or, `dryRun`, count) the account's data as `admin`: the rules, then the record, then the
 * pipeline — every platform table that holds the account's data and every module's erasure hook
 * (createPlatformPurgePipeline, audit X-15). Recorded before it runs; with no record it does not
 * run. Reaches outside the database (the hooks), so it is never inside a transaction.
 */
export async function handlePurgeUserData(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<PurgeActionResult> {
  const invalid = purgeInputProblem(input);
  if (invalid) return invalid;
  const refused = await checkPurgeUserData(input, admin);
  if (refused) return refused;
  if (!(await targetOf(input.userId))) return notFound();

  const request: PurgeRequest = {
    userId: input.userId,
    requestedBy: admin.userId,
    reason: input.reason,
    dryRun: input.dryRun === true,
  };
  let purge: PurgeResult | undefined;
  const result = await runAudited(
    {
      action: request.dryRun ? "gdpr_purge_dry_run" : "gdpr_purge_executed",
      actorId: admin.userId,
      targetId: request.userId,
      // The listed reason (PURGE_REASONS) as a code (rebase P-2): `reason` is free text, erased
      // with the account — and this record is about the account erased.
      details: { purgeReason: request.reason },
    },
    async () => {
      purge = await createPlatformPurgePipeline(admin.userId).execute(request);
      if (purge.status === "failed" && purge.steps.length === 0) {
        // No purge handlers registered.
        return coded("service.unavailable", { service: "gdpr_purge" });
      }
      return purge.status === "completed"
        ? {
            success: true,
            result: `Account data ${request.dryRun ? "counted" : "erased"}`,
          }
        : coded("admin.purge_incomplete", { status: purge.status });
    },
    // Every registered module's erasure hook may reach outside the database (review 14 L-6).
    { external: true }
  );
  return purge ? { ...result, purge } : result;
}
