/**
 * app/api/admin/ai/held-summary.ts — what a held command-bar action would do, for its approver
 * (TASK-194 round 1, findings A1, A3, A6)
 *
 * An approver saw a held action's label and risk, never its target: approving an erasure did
 * not say whose account it erased. Each held action that acts on one account names that account
 * here (ACCOUNT_TARGET_FIELD — the input field that carries it), and its summary is built on the
 * server from an allowlist — the account (id and address), and per action only: an erasure's
 * reason and dry-run flag; a role change's from-role and to-role; a restriction's feature. No
 * other payload field reaches the approvals list.
 *
 * The same target is what decideApproval compares with the approver (A3: never one's own
 * account, whatever the action) and what the erasure route compares with open erasure holds
 * (A6: one open erasure per account).
 *
 * @module app/api/admin/ai
 */

import { withTenantTx, type Tx } from "@/platform/data";
import { findRole } from "@/platform/auth/role-lookup";
import type { HeldActionSummary } from "@/platform/admin/pending-approvals";
import type { AdminToolId } from "./tool-permissions";
import { HELD_CURRENT_ROLE } from "./handlers/roles";
import { sameOptionalId } from "@/platform/auth/same-id";
import {
  APPROVERS,
  POLICY_EFFECTS,
  RISK_ORDER,
} from "@/platform/agents/approval-policy-store";

/* eslint-disable @typescript-eslint/no-explicit-any */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The input field naming the one account each account-targeting action acts on (a user id, or
 * for a role change an id or address). `__tests__/held-summary.test.ts` fails when a tool's
 * schema names a user field that is not registered here.
 */
export const ACCOUNT_TARGET_FIELD: Readonly<Partial<Record<AdminToolId, string>>> = {
  purge_user_data: "userId",
  change_user_role: "user_identifier",
  block_user_feature: "user_id",
  unblock_user_feature: "user_id",
};

/** The account a held action names: its id, address and role — or null when none is found. */
export interface HeldTarget {
  readonly id: string;
  readonly email: string | null;
  readonly roleName: string | null;
  readonly roleId: string | null;
}

/** The account `identifier` (an id, or an address) names in this tenant, deleted ones included. */
async function accountOf(tx: Tx, identifier: string): Promise<HeldTarget | null> {
  const { rows } = await tx.query<{
    id: string;
    email: string | null;
    role_id: string | null;
  }>(
    UUID.test(identifier)
      ? "select id, email, role_id from users where id = $1::uuid"
      : "select id, email, role_id from users where email = $1 and deleted_at is null limit 2",
    [identifier]
  );
  // An address two accounts share names neither (the handler refuses it too).
  if (rows.length !== 1) return null;
  const role = rows[0].role_id ? await findRole(tx, { id: rows[0].role_id }) : null;
  return {
    id: rows[0].id,
    email: rows[0].email ?? null,
    roleName: role?.name ?? null,
    roleId: rows[0].role_id ?? null,
  };
}

/**
 * The account a held `label` action names (undefined: the action names none; null: it names one
 * that is not found). A read error throws.
 */
export async function heldTargetAccount(
  label: string,
  payload: Readonly<Record<string, unknown>>
): Promise<HeldTarget | null | undefined> {
  const field = ACCOUNT_TARGET_FIELD[label as AdminToolId];
  if (!field) return undefined;
  const value = payload[field];
  if (typeof value !== "string" || !value) return null;
  return withTenantTx((tx) => accountOf(tx, value));
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v.slice(0, 200) : undefined;

/** The most permission codes one summary lists. */
const MAX_LISTED_PERMISSIONS = 100;

/**
 * The values of `v` that are permission codes of the catalog (TASK-202, N-61), in the order
 * given, each once — never free text from the payload. A read error throws (the summary is then
 * left out, as any summary that cannot be read).
 */
async function catalogCodes(v: unknown): Promise<string[]> {
  if (!Array.isArray(v)) return [];
  const asked = [
    ...new Set(v.filter((x): x is string => typeof x === "string" && x.length <= 100)),
  ].slice(0, MAX_LISTED_PERMISSIONS);
  if (asked.length === 0) return [];
  const { rows } = await withTenantTx((tx) =>
    tx.query<{ code: string }>(
      "select code from permissions where code = any($1::text[])",
      [asked]
    )
  );
  const known = new Set(rows.map((r) => r.code));
  return asked.filter((c) => known.has(c));
}

/** A role's permissions, by its name (null: no such role). */
async function rolePermissionsByName(name: unknown): Promise<readonly string[] | null> {
  if (typeof name !== "string" || !name) return null;
  const role = await withTenantTx((tx) => findRole(tx, { name }));
  return role ? role.permissions : null;
}

const listed = (v: unknown, values: readonly string[]): string | undefined =>
  typeof v === "string" && values.includes(v) ? v : undefined;

/** A held policy change's rules and default, each value one the policy knows ("?" if not). */
function policySummary(
  payload: Readonly<Record<string, any>>
): NonNullable<HeldActionSummary["approvalPolicy"]> {
  const rules = Array.isArray(payload.rules) ? payload.rules.slice(0, 50) : [];
  const defaultApprover = listed(payload.default_approver, APPROVERS);
  return {
    rules: rules.map((r: any) => {
      const effects = Array.isArray(r?.effects)
        ? r.effects.map((e: unknown) => listed(e, POLICY_EFFECTS) ?? "?")
        : [];
      return {
        maxRisk: listed(r?.max_risk, RISK_ORDER) ?? "?",
        ...(effects.length > 0 ? { effects } : {}),
        requiredApprover: listed(r?.required_approver, APPROVERS) ?? "?",
      };
    }),
    ...(payload.default_approver !== undefined
      ? { defaultApprover: defaultApprover ?? "?" }
      : {}),
  };
}

/**
 * The allowlisted summary of a held action, built on the server. An action that names no
 * account and carries none of the listed fields has none (undefined).
 */
export async function heldActionSummary(
  label: string,
  payload: Readonly<Record<string, any>>
): Promise<HeldActionSummary | undefined> {
  const target = await heldTargetAccount(label, payload);
  const base: HeldActionSummary =
    target === undefined
      ? {}
      : {
          target: target
            ? { id: target.id, ...(target.email ? { email: target.email } : {}) }
            : { notFound: true },
        };
  switch (label as AdminToolId) {
    case "purge_user_data":
      return {
        ...base,
        ...(text(payload.reason) ? { reason: text(payload.reason) } : {}),
        dryRun: payload.dryRun === true,
      };
    case "change_user_role": {
      // The role the change was held against (its snapshot, rebase P-1), and — when the
      // account's role is another one now — that one too: approving it would be refused as stale.
      const snapshotted = Object.prototype.hasOwnProperty.call(
        payload,
        HELD_CURRENT_ROLE
      );
      const heldRoleId = snapshotted ? (payload[HELD_CURRENT_ROLE] ?? null) : undefined;
      const fromRole = snapshotted
        ? typeof heldRoleId === "string"
          ? await withTenantTx((tx) => findRole(tx, { id: heldRoleId })).then(
              (r) => r?.name ?? undefined
            )
          : undefined
        : (target?.roleName ?? undefined);
      const changedSince =
        snapshotted && target && !sameOptionalId(target.roleId ?? null, heldRoleId);
      // What the move grants and takes away (N-61): the new role's permissions the role it was
      // held against lacks, and the reverse — each a catalog code.
      const fromId = snapshotted ? heldRoleId : (target?.roleId ?? null);
      const fromPerms =
        typeof fromId === "string"
          ? ((await withTenantTx((tx) => findRole(tx, { id: fromId })))?.permissions ??
            [])
          : [];
      const toPerms = await rolePermissionsByName(payload.new_role);
      const granted = toPerms ? toPerms.filter((p) => !fromPerms.includes(p)) : [];
      const removed = toPerms ? fromPerms.filter((p) => !toPerms.includes(p)) : [];
      return {
        ...base,
        ...(fromRole ? { fromRole } : {}),
        ...(text(payload.new_role) ? { toRole: text(payload.new_role) } : {}),
        ...(changedSince ? { roleChangedSince: { now: target.roleName ?? null } } : {}),
        ...(granted.length
          ? { permissionsGranted: granted.slice(0, MAX_LISTED_PERMISSIONS) }
          : {}),
        ...(removed.length
          ? { permissionsRemoved: removed.slice(0, MAX_LISTED_PERMISSIONS) }
          : {}),
      };
    }
    case "create_role": {
      const granted = await catalogCodes(payload.permissions);
      return {
        ...(text(payload.name) ? { role: text(payload.name) } : {}),
        ...(granted.length ? { permissionsGranted: granted } : {}),
      };
    }
    case "delete_role":
      return text(payload.role_name) ? { role: text(payload.role_name) } : undefined;
    case "duplicate_role": {
      // A copy holds every permission of its source: those are what it grants.
      const granted = (await rolePermissionsByName(payload.source_role)) ?? [];
      return {
        ...(text(payload.new_name) ? { role: text(payload.new_name) } : {}),
        ...(text(payload.source_role) ? { fromRole: text(payload.source_role) } : {}),
        ...(granted.length
          ? { permissionsGranted: granted.slice(0, MAX_LISTED_PERMISSIONS) }
          : {}),
      };
    }
    case "assign_permissions": {
      const granted = await catalogCodes(payload.add);
      const removed = await catalogCodes(payload.remove);
      return {
        ...(text(payload.role_name) ? { role: text(payload.role_name) } : {}),
        ...(granted.length ? { permissionsGranted: granted } : {}),
        ...(removed.length ? { permissionsRemoved: removed } : {}),
      };
    }
    case "create_entitlement_group": {
      const granted = await catalogCodes(payload.permissions);
      return {
        ...(text(payload.code) ? { group: text(payload.code) } : {}),
        ...(granted.length ? { permissionsGranted: granted } : {}),
      };
    }
    case "set_entitlement_group_active": {
      // The group by its code (a stored value, never the payload's text) and what it grants.
      const id = payload.group_id;
      const group =
        typeof id === "string" && UUID.test(id)
          ? (
              await withTenantTx((tx) =>
                tx.query<{ code: string; permissions: string[] | null }>(
                  `select g.code, array_agg(p.code order by p.code)
                            filter (where p.code is not null) as permissions
                     from entitlement_groups g
                     left join entitlement_permissions ep on ep.entitlement_group_id = g.id
                     left join permissions p on p.id = ep.permission_id
                    where g.id = $1::uuid
                    group by g.code`,
                  [id]
                )
              )
            ).rows[0]
          : undefined;
      const perms = (group?.permissions ?? []).slice(0, MAX_LISTED_PERMISSIONS);
      return {
        ...(group ? { group: group.code } : {}),
        ...(typeof payload.is_active === "boolean" ? { active: payload.is_active } : {}),
        ...(perms.length
          ? payload.is_active === false
            ? { permissionsRemoved: perms }
            : { permissionsGranted: perms }
          : {}),
      };
    }
    case "block_user_feature":
    case "unblock_user_feature":
      return {
        ...base,
        ...(text(payload.feature) ? { feature: text(payload.feature) } : {}),
      };
    // What a held policy change would store (round 12, I-2 (d); pre-existing 2: its approver saw
    // only its label): each rule and the default approver — listed values only, at most 50 rules.
    case "set_approval_policy":
      return { ...base, approvalPolicy: policySummary(payload) };
    default:
      return target === undefined ? undefined : base;
  }
}
