/**
 * platform/admin/eligible-approvers.ts — who could approve a dual-controlled action (N-24, N-85)
 *
 * Every dual-controlled action — an erasure, a role change, a held setting, a tenant's deletion,
 * an erasure's attestation — waits for an approver who is not the requester and holds every
 * permission the approval needs (the rules are the decision's own: approval-decision.ts,
 * hold-authority.ts, erasure-attestation.ts, tenancy/admin.ts — strict, and unchanged here).
 * Nothing checked that such a person existed: a deployment with one super_admin accepted an
 * erasure, held it, and it lapsed unapproved while the erasure deadline ran (S3-E3).
 *
 * Two uses of one reading:
 *
 *   - the request path refuses a request up front when no account but the requester (and the
 *     account it acts on) could approve it: `approvals.no_eligible_approver`, naming the action and
 *     what its approver must hold — nothing is held (noApproverRefusal);
 *   - operator readiness reports every dual-controlled action no second account could approve
 *     (platform/admin/dual-control-readiness.ts).
 *
 * In a shared deployment an operator of any tenant may also decide a tenant's held change or hold
 * (holding platform_operate and every permission the approval needs): counted too (asOperator).
 *
 * "Could approve" is read as the permission engine resolves it (platform/auth/permissions.ts): an
 * account in good standing — not deleted; active or warned, or a restriction or suspension whose
 * end has passed — holding each permission by its role, a role it inherits or an active
 * entitlement. An action's own rules beyond its permissions (a role change needs every permission
 * of both roles) are checked per account by the caller's `rule`, the same function the decision
 * runs. Read-only; a read failure throws (the caller fails closed).
 *
 * @module platform/admin
 */

import { withOwnerTx, withTenantTx, type Tx } from "@/platform/data";
import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import { sameId } from "@/platform/auth/same-id";
import type { ErrorCode, ErrorParams } from "@/platform/errors";
import { peekTenant } from "@/platform/tenancy/context";

/** Who may reach the admin area at all (admin-guard's gate): every approver holds it. */
export const ADMIN_ACCESS = "can_access_admin";
/** An operator: the approver of an operator's dual-controlled action. */
export const OPERATOR_ACCESS = "platform_operate";

/** A staff account in good standing, with its effective permissions. */
export interface StaffAccount extends VerifiedAdmin {
  readonly tenantId: string;
  readonly email: string | null;
}

interface StaffRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  sub: string | null;
  email: string | null;
  role_name: string | null;
  permissions: string[] | null;
}

/**
 * The staff accounts (holding can_access_admin or platform_operate) in good standing, each with
 * every permission it holds — by its role, an inherited role or an active entitlement. Marked
 * `eligible-approvers` (__tests__/helpers/fake-data.ts answers it in unit tests).
 */
export const STAFF_SQL = `/* eligible-approvers */
  with eff as (
    select u.id, u.tenant_id, u.cognito_sub, u.email, u.role_id, perm.code
      from users u
      join permissions perm on perm.id in (
        select rp.permission_id from role_permissions rp
         where rp.role_id = u.role_id
        union
        select rp.permission_id from role_permissions rp
          join role_inheritance ri on ri.inherits_from_id = rp.role_id
         where ri.role_id = u.role_id
        union
        select ep.permission_id
          from user_entitlements e
          join entitlement_groups g on g.id = e.entitlement_group_id
          join entitlement_permissions ep on ep.entitlement_group_id = g.id
         where e.user_id = u.id and e.revoked_at is null
           and (e.expires_at is null or e.expires_at > now()) and g.is_active)
     where u.deleted_at is null
       and (u.account_status in ('active', 'warned')
            or (u.account_status = 'restricted' and u.restricted_until < now())
            or (u.account_status = 'suspended' and u.suspended_until < now()))
  )
  select e.id::text as id, e.tenant_id::text as tenant_id, e.cognito_sub as sub, e.email,
         r.name as role_name, array_agg(distinct e.code order by e.code) as permissions
    from eff e
    left join roles r on r.id = e.role_id
   group by e.id, e.tenant_id, e.cognito_sub, e.email, r.name
  having bool_or(e.code in ('${ADMIN_ACCESS}', '${OPERATOR_ACCESS}'))
   order by e.tenant_id, e.id`;

async function readStaff(tx: Tx): Promise<StaffAccount[]> {
  const { rows } = await tx.query<StaffRow>(STAFF_SQL);
  return rows.map((r) => ({
    userId: r.id,
    tenantId: r.tenant_id,
    sub: r.sub ?? "",
    email: r.email,
    roleName: r.role_name ?? "unknown",
    permissions: r.permissions ?? [],
  }));
}

/** The staff of the request's tenant (row-level security keeps it to that tenant). */
export function staffOfTenant(): Promise<StaffAccount[]> {
  return withTenantTx(readStaff);
}

/** The staff of every tenant: for operators' actions and operator readiness. */
export function staffOfDeployment(): Promise<StaffAccount[]> {
  return withOwnerTx("operator", readStaff);
}

/** Whether `account` is one of `ids`: its id (any spelling), its subject or its address. */
export function isOneOf(
  account: StaffAccount,
  ids: readonly (string | null | undefined)[]
): boolean {
  return ids.some(
    (x) =>
      typeof x === "string" &&
      x.length > 0 &&
      (sameId(x, account.userId) ||
        (account.sub !== "" && sameId(x, account.sub)) ||
        (account.email !== null &&
          x.trim().toLowerCase() === account.email.toLowerCase()))
  );
}

/** What an approver of one action must be. */
export interface ApproverNeeds {
  /** Every permission the approval needs (the action's own, the admin area, an operator's…). */
  readonly permissions: readonly string[];
  /** Who may not approve: the requester (by any of its ids) and the account the action acts on. */
  readonly excluded?: readonly (string | null | undefined)[];
  /** The action's own rule for an approver (the decision's), refusing with anything truthy. */
  readonly rule?: (approver: VerifiedAdmin) => unknown;
}

/** The accounts of `staff` that could approve: every permission, not excluded, the rule passed. */
export function eligibleApprovers(
  staff: readonly StaffAccount[],
  needs: ApproverNeeds
): StaffAccount[] {
  return staff.filter(
    (s) =>
      needs.permissions.every((p) => holds(s, p)) &&
      !isOneOf(s, needs.excluded ?? []) &&
      !(needs.rule && needs.rule(s))
  );
}

/** The refusal of a request no one else could approve. */
export interface NoApproverRefusal {
  readonly code: ErrorCode & "approvals.no_eligible_approver";
  readonly params: ErrorParams & {
    readonly action: string;
    readonly permissions: readonly string[];
  };
  readonly message: string;
}

/** The refusal for `action`, naming what its approver must hold. */
export function noApprover(
  action: string,
  permissions: readonly string[]
): NoApproverRefusal {
  return {
    code: "approvals.no_eligible_approver",
    params: { action, permissions: [...permissions] },
    message: `No one else can approve ${action}: it needs another active account holding ${permissions.join(", ")}. Nothing was held.`,
  };
}

/**
 * The approvers of a tenant's action an operator also is (a shared deployment): an operator of any
 * tenant decides a tenant's held change or hold under the same rules — every permission the
 * approval needs, and platform_operate (the operators' approval routes; ADR-053 D5, round 7 I-3).
 */
export function asOperator(needs: ApproverNeeds): ApproverNeeds {
  return { ...needs, permissions: [...needs.permissions, OPERATOR_ACCESS] };
}

/**
 * Refuse a request up front when no account but the requester (and the account it acts on) could
 * approve it (N-24): the refusal, or null when someone could. `across: "deployment"` weighs every
 * tenant's staff (an operator's action); otherwise the request's tenant — and, when the request
 * runs in a shared deployment (its tenant context's mode), every tenant's operators too
 * (asOperator). A read failure throws.
 */
export async function noApproverRefusal(
  action: string,
  needs: ApproverNeeds,
  across: "tenant" | "deployment" = "tenant"
): Promise<NoApproverRefusal | null> {
  if (across === "deployment")
    return eligibleApprovers(await staffOfDeployment(), needs).length > 0
      ? null
      : noApprover(action, needs.permissions);
  if (eligibleApprovers(await staffOfTenant(), needs).length > 0) return null;
  if (
    peekTenant()?.mode === "shared" &&
    eligibleApprovers(await staffOfDeployment(), asOperator(needs)).length > 0
  )
    return null;
  return noApprover(action, needs.permissions);
}
