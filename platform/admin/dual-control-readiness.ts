/**
 * platform/admin/dual-control-readiness.ts — does every dual-controlled action have someone to
 * approve it? (N-24, N-85; operator readiness)
 *
 * A dual-controlled action is approved by an account other than its requester that holds every
 * permission the approval needs. With one super_admin and no second holder, an erasure, a role
 * change or a held setting is accepted, held and lapses unapproved; readiness said nothing
 * (S3-E3). This check names each such action. It reads; it changes nothing; and it never loosens a
 * rule — the rules are the decisions' own (the owner's decision, 2026-11-07: they stay strict).
 *
 * The actions weighed:
 *
 *   - the platform's: every held setting (ALWAYS_DUAL_CONTROLLED and config.dual_control_keys) —
 *     its tier's permission (config_manage_standard or _safety) and the admin area; in a shared
 *     deployment a platform default's approver is also an operator, across tenants;
 *   - an operator's: an erasure's attestation (and, shared, a tenant's deletion) — two operators
 *     (platform_operate), across tenants;
 *   - an app's own holds, as it declares them (`extra`; PF's command bar: every action of
 *     admin.dual_control_actions and the always-held erasure, with each one's permission, the
 *     admin area and — a role change — every permission of the role it gives:
 *     app/api/admin/ai/command-bar.ts commandBarDualControlledActions).
 *
 * The rule (N-24): an action is ready when every account that could ask for it has another who
 * could approve it. Asking needs what approving needs (the same permission and the same rules), so
 * that is two eligible accounts — in each tenant that has staff, for a tenant's action; across the
 * deployment, for an operator's. One is not ready: the action is named, with what its approver
 * must hold.
 *
 * @module platform/admin
 */

import { getConfigOrThrow, getPermissionTier } from "@/platform/auth/platform-config";
import { getTenancySettings } from "@/platform/providers/environment-contract";
import { PROTECTED_ROLES } from "@/platform/auth/role-governance";
import { withOwnerTx } from "@/platform/data";
import { sameId } from "@/platform/auth/same-id";
import { ALWAYS_DUAL_CONTROLLED } from "./config-handlers";
import {
  ADMIN_ACCESS,
  OPERATOR_ACCESS,
  asOperator,
  eligibleApprovers,
  staffOfDeployment,
  type ApproverNeeds,
  type StaffAccount,
} from "./eligible-approvers";

/** One dual-controlled action and what its approver must be. */
export interface DualControlledAction extends ApproverNeeds {
  /** How readiness names it: "purge_user_data", "setting jobs.gdpr.retention-purge.enabled"… */
  readonly action: string;
  /** Weighed within each tenant (a tenant's own action) or across the deployment (an operator's). */
  readonly across: "tenant" | "deployment";
}

/** A role an administrator may give (never a protected one), with every permission it grants. */
export interface AssignableRole {
  readonly name: string;
  readonly permissions: readonly string[];
}

/** The roles that can be given in the app, each with its permissions (inherited ones included). */
export async function assignableRoles(): Promise<AssignableRole[]> {
  const { rows } = await withOwnerTx("operator", (tx) =>
    tx.query<{ name: string; permissions: string[] | null }>(
      `select r.name,
              array(select distinct p.code
                      from permissions p
                     where p.id in (select rp.permission_id from role_permissions rp
                                     where rp.role_id = r.id
                                    union
                                    select rp.permission_id from role_permissions rp
                                      join role_inheritance ri on ri.inherits_from_id = rp.role_id
                                     where ri.role_id = r.id)
                     order by p.code) as permissions
         from roles r
        order by r.name`
    )
  );
  return rows
    .filter((r) => !PROTECTED_ROLES.includes(r.name))
    .map((r) => ({ name: r.name, permissions: r.permissions ?? [] }));
}

const tierPermission = (tier: string) =>
  tier === "standard" ? "config_manage_standard" : "config_manage_safety";

/** The platform's own dual-controlled actions: held settings and operators' attestations. */
export async function platformDualControlledActions(): Promise<DualControlledAction[]> {
  const shared = getTenancySettings().mode === "shared";
  const listed = await getConfigOrThrow<unknown>("config.dual_control_keys");
  const keys = [
    ...new Set([
      ...ALWAYS_DUAL_CONTROLLED,
      ...(Array.isArray(listed) ? listed.filter((k) => typeof k === "string") : []),
    ]),
  ].sort();
  const actions: DualControlledAction[] = [];
  for (const key of keys) {
    const permission = tierPermission(await getPermissionTier(key));
    actions.push({
      action: `setting ${key}`,
      permissions: [permission, ADMIN_ACCESS],
      across: "tenant",
    });
    // A shared deployment's platform default is an operator's to approve (ADR-053 D5).
    if (shared) {
      actions.push({
        action: `setting ${key} (platform default)`,
        permissions: [permission, ADMIN_ACCESS, OPERATOR_ACCESS],
        across: "deployment",
      });
    }
  }
  actions.push({
    action: "erasure attestation",
    permissions: [OPERATOR_ACCESS],
    across: "deployment",
  });
  if (shared) {
    actions.push({
      action: "tenant deletion",
      permissions: [OPERATOR_ACCESS],
      across: "deployment",
    });
  }
  return actions;
}

/** One action no second account could approve, where. */
export interface UnapprovableAction {
  readonly action: string;
  readonly permissions: readonly string[];
  /** The tenant (slug, else id) for a tenant's action; absent for an operator's. */
  readonly tenant?: string;
  /** How many accounts could ask for it (0 or 1). */
  readonly eligible: number;
}

/**
 * The actions without a second eligible approver: for a tenant's action, in every tenant that has
 * staff (an account holding the admin area) — with, in a shared deployment (`shared`), the other
 * tenants' operators who could decide it (asOperator); for an operator's, across the deployment.
 */
export function unapprovable(
  actions: readonly DualControlledAction[],
  staff: readonly StaffAccount[],
  tenantNames: ReadonlyMap<string, string> = new Map(),
  shared = false
): UnapprovableAction[] {
  const byTenant = new Map<string, StaffAccount[]>();
  for (const s of staff)
    byTenant.set(s.tenantId, [...(byTenant.get(s.tenantId) ?? []), s]);
  const staffed = [...byTenant.entries()]
    .filter(([, members]) =>
      members.some(
        (m) => m.permissions.includes(ADMIN_ACCESS) || m.permissions.includes("*")
      )
    )
    .sort(([a], [b]) => a.localeCompare(b));
  const out: UnapprovableAction[] = [];
  for (const a of actions) {
    if (a.across === "deployment") {
      const n = eligibleApprovers(staff, a).length;
      if (n < 2) out.push({ action: a.action, permissions: a.permissions, eligible: n });
      continue;
    }
    for (const [tenantId, members] of staffed) {
      // A shared deployment's operators of other tenants decide a tenant's holds too.
      const operators = shared
        ? eligibleApprovers(
            staff.filter((s) => !sameId(s.tenantId, tenantId)),
            asOperator(a)
          )
        : [];
      const n = eligibleApprovers(members, a).length + operators.length;
      if (n < 2)
        out.push({
          action: a.action,
          permissions: a.permissions,
          tenant: tenantNames.get(tenantId) ?? tenantId,
          eligible: n,
        });
    }
  }
  return out;
}

export interface DualControlReadiness {
  readonly state: "ready" | "not_ready" | "unknown";
  readonly detail: string;
  readonly unapprovable: readonly UnapprovableAction[];
}

/** The readable sentence for the actions without an approver. */
export function describeUnapprovable(
  missing: readonly UnapprovableAction[],
  single: boolean
): string {
  if (missing.length === 0)
    return "Every dual-controlled action has a second account that may approve it.";
  const parts = missing.map(
    (m) =>
      `${m.action}${m.tenant && !single ? ` in tenant ${m.tenant}` : ""} (its approver needs ${m.permissions.join(", ")}; ${m.eligible === 0 ? "no account holds them" : "one account holds them: the requester could not be approved"})`
  );
  return `No second approver for: ${parts.join("; ")}. Give a second person those permissions (TENANCY_OPERATIONS: the second super admin, the first safety approver).`;
}

/**
 * Whether every dual-controlled action has a second eligible approver. `extra`: an app's own held
 * actions (the routes pass PF's command bar). Never throws: a read failure is `unknown`.
 */
export async function checkDualControlReadiness(
  extra: () => Promise<readonly DualControlledAction[]> = async () => []
): Promise<DualControlReadiness> {
  try {
    const [platform, app, staff, names] = await Promise.all([
      platformDualControlledActions(),
      extra(),
      staffOfDeployment(),
      withOwnerTx("operator", (tx) =>
        tx.query<{ id: string; slug: string | null }>(
          "select id::text as id, slug from tenants"
        )
      ),
    ]);
    const tenantNames = new Map(names.rows.map((r) => [r.id, r.slug ?? r.id]));
    const shared = getTenancySettings().mode === "shared";
    const missing = unapprovable([...app, ...platform], staff, tenantNames, shared);
    return {
      state: missing.length === 0 ? "ready" : "not_ready",
      detail: describeUnapprovable(missing, !shared),
      unapprovable: missing,
    };
  } catch (err) {
    return {
      state: "unknown",
      detail: `Who may approve could not be read (${err instanceof Error ? err.name : "error"}).`,
      unapprovable: [],
    };
  }
}
