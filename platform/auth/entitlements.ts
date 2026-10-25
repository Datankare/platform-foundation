/**
 * platform/auth/entitlements.ts — Entitlements engine
 *
 * Manages entitlement groups and user-to-group assignments.
 * Entitlements are additive grants on top of the primary role —
 * they never remove permissions, only add.
 *
 * Assignments (user_entitlements) are the tenant's, read and written through platform/data in
 * the request's tenant (ADR-053 D4); the group catalog (entitlement_groups) is platform-owned
 * and only read here. Every mutation is audit-logged.
 *
 * Granting or revoking applies the role rules (platform/auth/role-governance.ts) itself, to the
 * verified admin it is given (release review RR-17: it was exported with no rule, so any future
 * caller could hand any group to anyone): no one changes their own entitlements, and no one
 * grants — or takes away — a group carrying a permission they do not hold. The group's
 * permissions are read in the transaction that writes the grant.
 *
 * Sprint 3, Task 3.3
 */

import { withTenantTx } from "@/platform/data";
import { logger } from "@/lib/logger";
import { AuditWriteError, audited } from "@/platform/auth/audit";
import {
  checkPermissionGrant,
  type RoleRefusal,
  type VerifiedAdmin,
} from "@/platform/auth/role-governance";
import type { Tx } from "@/platform/data";

export interface EntitlementGrant {
  userId: string;
  entitlementGroupId: string;
  /** The verified admin granting it; the rules are applied to them. */
  grantedBy: VerifiedAdmin;
  expiresAt?: string;
}

export interface EntitlementRevoke {
  userId: string;
  entitlementGroupId: string;
  /** The verified admin revoking it; the rules are applied to them. */
  revokedBy: VerifiedAdmin;
}

/** A grant or revoke refused by a rule, with its coded reason. */
export class EntitlementRuleError extends Error {
  constructor(readonly refusal: RoleRefusal) {
    super(refusal.code);
    this.name = "EntitlementRuleError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Apply the rules to `admin` changing `userId`'s membership of `groupId`, inside `tx`. */
async function checkRules(
  tx: Tx,
  admin: VerifiedAdmin,
  userId: string,
  groupId: string
): Promise<void> {
  if (userId === admin.userId) {
    throw new EntitlementRuleError({ code: "auth.role_self_change", params: {} });
  }
  if (!UUID_RE.test(groupId)) return; // no such group: the write itself refuses it
  const { rows } = await tx.query<{ code: string }>(
    `select p.code from entitlement_permissions ep
       join permissions p on p.id = ep.permission_id
      where ep.entitlement_group_id = $1::uuid`,
    [groupId]
  );
  const refused = checkPermissionGrant(
    admin,
    rows.map((r) => r.code)
  );
  if (refused) throw new EntitlementRuleError(refused);
}

/** Run a write; its error message, or undefined when it succeeded. */
async function failure(write: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await write();
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Grant an entitlement group to a user.
 * Idempotent — if the user already has the entitlement, updates expiry.
 */
export async function grantEntitlement(
  grant: EntitlementGrant
): Promise<{ success: boolean; error?: string }> {
  try {
    // Recorded before the grant takes effect; no record, no grant (Adversarial Validation, 6).
    return await audited(
      {
        action: "entitlement_granted",
        actorId: grant.grantedBy.userId,
        targetId: grant.userId,
        details: {
          entitlementGroupId: grant.entitlementGroupId,
          expiresAt: grant.expiresAt || null,
        },
      },
      async () => {
        const error = await failure(() =>
          withTenantTx(async (tx) => {
            await checkRules(tx, grant.grantedBy, grant.userId, grant.entitlementGroupId);
            await tx.query(
              `insert into user_entitlements
                 (user_id, entitlement_group_id, granted_by, expires_at, revoked_at)
               values ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, null)
               on conflict (user_id, entitlement_group_id) do update
                 set granted_by = excluded.granted_by,
                     expires_at = excluded.expires_at,
                     revoked_at = null`,
              [
                grant.userId,
                grant.entitlementGroupId,
                grant.grantedBy.userId,
                grant.expiresAt || null,
              ]
            );
          })
        );

        if (error) {
          logger.error("Failed to grant entitlement", {
            error,
            route: "platform/auth/entitlements",
          });
          return { success: false, error };
        }

        return { success: true };
      }
    );
  } catch (err) {
    if (err instanceof AuditWriteError)
      return { success: false, error: "audit unavailable" };
    const message = err instanceof Error ? err.message : "Grant failed";
    logger.error("Entitlement grant error", {
      error: message,
      route: "platform/auth/entitlements",
    });
    return { success: false, error: message };
  }
}

/**
 * Revoke an entitlement group from a user.
 * Sets revoked_at — does not delete the record (audit trail preserved).
 */
export async function revokeEntitlement(
  revoke: EntitlementRevoke
): Promise<{ success: boolean; error?: string }> {
  try {
    return await audited(
      {
        action: "entitlement_revoked",
        actorId: revoke.revokedBy.userId,
        targetId: revoke.userId,
        details: {
          entitlementGroupId: revoke.entitlementGroupId,
        },
      },
      async () => {
        const error = await failure(() =>
          withTenantTx(async (tx) => {
            await checkRules(
              tx,
              revoke.revokedBy,
              revoke.userId,
              revoke.entitlementGroupId
            );
            await tx.query(
              `update user_entitlements set revoked_at = now(), revoked_by = $3::uuid
                where user_id = $1::uuid and entitlement_group_id = $2::uuid
                  and revoked_at is null`,
              [revoke.userId, revoke.entitlementGroupId, revoke.revokedBy.userId]
            );
          })
        );

        if (error) {
          logger.error("Failed to revoke entitlement", {
            error,
            route: "platform/auth/entitlements",
          });
          return { success: false, error };
        }

        return { success: true };
      }
    );
  } catch (err) {
    if (err instanceof AuditWriteError)
      return { success: false, error: "audit unavailable" };
    const message = err instanceof Error ? err.message : "Revoke failed";
    logger.error("Entitlement revoke error", {
      error: message,
      route: "platform/auth/entitlements",
    });
    return { success: false, error: message };
  }
}

/**
 * Get all active entitlements for a user: grants that are not revoked and not expired, in
 * groups that are active. An unreadable store reads as none.
 */
export async function getUserEntitlements(
  userId: string
): Promise<{ entitlementGroupId: string; code: string; expiresAt: string | null }[]> {
  let rows: { id: string; code: string; expires_at: Date | null }[];
  try {
    ({ rows } = await withTenantTx((tx) =>
      tx.query<{ id: string; code: string; expires_at: Date | null }>(
        `select g.id, g.code, e.expires_at
           from user_entitlements e
           join entitlement_groups g on g.id = e.entitlement_group_id
          where e.user_id = $1::uuid and e.revoked_at is null
            and (e.expires_at is null or e.expires_at > now())
            and g.is_active`,
        [userId]
      )
    ));
  } catch {
    return [];
  }

  return rows.map((g) => ({
    entitlementGroupId: g.id,
    code: g.code,
    expiresAt: g.expires_at ? g.expires_at.toISOString() : null,
  }));
}
