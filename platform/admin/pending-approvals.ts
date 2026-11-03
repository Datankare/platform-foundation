/**
 * platform/admin/pending-approvals.ts — the unified pending-approvals read model (ADR-040).
 *
 * Merges the two hold mechanisms into one PendingApproval[] for the admin surface:
 *   - runtime holds an authority owns (platform/admin/hold-authority.ts: the config tools', and
 *     the authorities an app passes — PF's command bar); proposalStore, status "proposed"
 *   - config-approval two-person  (config_pending_approvals, status "pending")
 * Each carries the permission required to clear it — its authority's for a runtime hold, the
 * config key's permission_tier (fail-closed to safety) for a config approval — per ADR-040's
 * approver model: "you may clear a held change iff you are independently authorized to make it."
 * A runtime hold no authority owns (an agent's workflow step, its own user's to decide) is not
 * listed here (audit B-10).
 *
 * Read-only (040a). Approve/reject is 040b (POST /api/admin/approvals/[id]).
 */

import type { EffectType, RiskLevel, ProposalRecord } from "@/platform/kernel/types";
import type { ConfigApprovalRecord } from "@/platform/admin/types";
import { getProposalStore } from "@/platform/agents/proposal-store";
import { listApprovals } from "@/platform/admin/config-approval";
import { getPermissionTier } from "@/platform/auth/platform-config";
import { authorityFor, type HoldAuthority } from "@/platform/admin/hold-authority";
import { approvalExpiryDays, holdLapsed } from "@/platform/admin/hold-expiry";
import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import { withTenantTx } from "@/platform/data";

export { proposalConfigKey } from "@/platform/admin/hold-authority";

export type PendingApprovalSource = "runtime" | "config-approval";

/** The permission that authorizes making — and therefore clearing — a held change. */
export type ApprovalPermission = string;

/**
 * What a held action would do, built on the server from an allowlist (TASK-194 round 1, A1): the
 * account it acts on (id and address — or `notFound`), and per action only an erasure's reason
 * and dry-run flag, a role change's from-role and to-role, a restriction's feature. Nothing else
 * from the held payload is shown.
 */
export interface HeldActionSummary {
  readonly target?:
    | { readonly id: string; readonly email?: string; readonly notFound?: never }
    | { readonly notFound: true; readonly id?: never; readonly email?: never };
  readonly reason?: string;
  readonly dryRun?: boolean;
  readonly fromRole?: string;
  readonly toRole?: string;
  /**
   * A held role change whose account has another role now than the one it was held against
   * (rebase P-1): approving it is refused as stale. `now`: that role's name (null: none).
   */
  readonly roleChangedSince?: { readonly now: string | null };
  readonly feature?: string;
  /**
   * A held approval-policy change (round 12, I-2 (d)): the rules it would store, in order, and
   * the default approver it would set (absent: the current one stands) — only listed values.
   */
  readonly approvalPolicy?: {
    readonly rules: readonly {
      readonly maxRisk: string;
      readonly effects?: readonly string[];
      readonly requiredApprover: string;
    }[];
    readonly defaultApprover?: string;
  };
}

/** A unified, source-agnostic view of one held change awaiting an independent approver. */
export interface PendingApproval {
  readonly source: PendingApprovalSource;
  /** Stable id within its source store (proposalId | approval id). */
  readonly id: string;
  /** Human-facing label: the tool/action id (runtime) or the config key (config-approval). */
  readonly label: string;
  /** The config key at stake, when the hold concerns one. */
  readonly configKey?: string;
  /** The actor who requested the change; an approver must differ from this (ADR-040). */
  readonly requester: string;
  /** The permission an approver must independently hold to clear this (ADR-040). */
  readonly requiredPermission: ApprovalPermission;
  readonly effectiveRisk?: RiskLevel;
  readonly effects?: readonly EffectType[];
  /** "Why held", in plain terms, for the surface. */
  readonly reason: string;
  /**
   * An approved run whose outcome is unknown (review 11 H-1): decided by "mark_executed" (after
   * verifying it took effect), "reapprove" or "withdraw" (after verifying it did not: run again,
   * or closed without running — TASK-194 round 5) — never approve/reject.
   */
  readonly undecided?: boolean;
  /**
   * An undecided run no one in its tenant may approve again or mark executed (round 7, I-3):
   * every account in good standing holding its permission and `can_access_admin` (round 8, item
   * 6) is its requester or the account it acts on, or fails the change's own rules (round 9,
   * P-2). One who holds it but fails those rules may still withdraw it (the rules bind only the
   * decisions that run the change or declare it done). Read only for a viewer (the Approvals
   * screens; round 8, item 5). It never lapses (an undecided run waits for a person); a platform
   * operator decides it, in that tenant (POST /api/operator/tenants/[id]/approvals/[approvalId]).
   * Absent when someone may, or when that could not be read.
   */
  readonly noEligibleDecider?: boolean;
  /**
   * What the held action would do (its authority's summary), when it has one (A1) — given only to
   * a viewer holding `requiredPermission` (round 2, N2).
   */
  readonly summary?: HeldActionSummary;
  readonly createdAt: string;
}

/** Map a permission_tier to the permission that governs its edit (and thus its approval). */
function permissionForTier(tier: "standard" | "safety"): ApprovalPermission {
  return tier === "standard" ? "config_manage_standard" : "config_manage_safety";
}

/**
 * The permission required to clear a hold — derived from the config key's tier
 * (fail-closed to safety when there is no key, per getPermissionTier).
 */
export async function requiredPermissionForKey(
  configKey?: string
): Promise<ApprovalPermission> {
  if (!configKey) return "config_manage_safety";
  return permissionForTier(await getPermissionTier(configKey));
}

/** Who may reach an approvals screen at all (admin-guard's gate): a decider holds it too. */
const ADMIN_ACCESS = "can_access_admin";

/**
 * How many of a hold's possible deciders its approver rules are checked against (round 9, P-2):
 * past this many, the hold is taken as decidable — a bound on the extra pass, never a claim.
 */
const RULE_CHECKED_DECIDERS = 10;

/** One possible decider of one hold, as the statement below reads it. */
interface DeciderRow {
  readonly hold_id: string;
  readonly user_id: string | null;
  readonly sub: string | null;
  readonly role_name: string | null;
  readonly permissions: string[] | null;
  readonly total: number;
}

/**
 * The undecided holds no account in the current tenant may decide (round 7, I-3; round 8, items
 * 5 and 6; round 9, P-2). One statement reads, for all of them, the accounts in good standing that
 * hold both the hold's permission and `can_access_admin` — each by its role, an inherited role or
 * an active entitlement, as the permission engine resolves it (platform/auth/permissions.ts) —
 * other than the hold's requesters (independence, ADR-040) and the account it acts on (A3: every
 * account a value of its payload names, by id or address): up to RULE_CHECKED_DECIDERS of them,
 * with their permissions. Then, where the hold's authority has approver rules (C-2: a role change
 * only by one holding every permission of both roles, …), the rules' facts are read once for the
 * hold (HoldAuthority.approverRuleCheck — the account, both roles' permissions, …) and each of
 * those candidates is decided against them in memory, by the same rule the decision applies —
 * one read per hold, whatever the number of candidates: a hold none of whom may decide is flagged
 * too (round 10, I-C). An empty
 * set when that cannot be read, and a hold whose rules cannot be read is not flagged: the listing
 * never claims it on a guess.
 */
async function holdsNoOneMayDecide(
  holds: readonly {
    readonly p: ProposalRecord;
    readonly authority: HoldAuthority;
    readonly permission: string;
  }[]
): Promise<ReadonlySet<string>> {
  if (holds.length === 0) return new Set();
  const excluded = holds.map(({ p }) =>
    JSON.stringify(
      [
        p.actor.actorId,
        p.actor.onBehalfOf,
        p.actor.delegation?.onBehalfOf,
        ...Object.values(p.payload),
      ].filter((x): x is string => typeof x === "string" && x.length > 0)
    )
  );
  const codes = [...new Set([...holds.map((h) => h.permission), ADMIN_ACCESS])];
  let rows: readonly DeciderRow[];
  try {
    rows = (
      await withTenantTx((tx) =>
        tx.query<DeciderRow>(
          `with eff as (
             select u.id, u.cognito_sub, u.email, u.role_id, perm.code
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
                and u.id in (
                  select u2.id from users u2
                    join role_permissions rp2 on rp2.role_id = u2.role_id
                    join permissions p2 on p2.id = rp2.permission_id and p2.code = any($4::text[])
                  union
                  select e2.user_id from user_entitlements e2
                    join entitlement_permissions ep2 on ep2.entitlement_group_id = e2.entitlement_group_id
                    join permissions p3 on p3.id = ep2.permission_id and p3.code = any($4::text[])
                  union
                  select u3.id from users u3
                    join role_inheritance ri3 on ri3.role_id = u3.role_id
                    join role_permissions rp3 on rp3.role_id = ri3.inherits_from_id
                    join permissions p4 on p4.id = rp3.permission_id and p4.code = any($4::text[]))
           ),
           candidates as (
             select h.hold_id, x.id, x.cognito_sub, x.role_id
               from unnest($1::text[], $2::text[], $3::text[]) as h(hold_id, permission, excluded)
               join (select distinct id, cognito_sub, email, role_id from eff) x
                 on exists (select 1 from eff a where a.id = x.id and a.code = h.permission)
                and exists (select 1 from eff a where a.id = x.id and a.code = $5)
                and not exists (
                  select 1 from jsonb_array_elements_text(h.excluded::jsonb) as ex(v)
                   where lower(ex.v) in (lower(x.id::text), lower(coalesce(x.cognito_sub, '')),
                                         lower(coalesce(x.email, ''))))
           ),
           ranked as (
             select c.*, row_number() over (partition by c.hold_id order by c.id) as k,
                    count(*) over (partition by c.hold_id)::int as total
               from candidates c
           )
           select h.hold_id, r.id::text as user_id, r.cognito_sub as sub, ro.name as role_name,
                  case when r.id is null then null
                       else (select array_agg(distinct a.code) from eff a where a.id = r.id) end
                    as permissions,
                  coalesce(r.total, 0) as total
             from unnest($1::text[]) as h(hold_id)
             left join ranked r on r.hold_id = h.hold_id and r.k <= $6
             left join roles ro on ro.id = r.role_id`,
          [
            holds.map(({ p }) => p.proposalId),
            holds.map((h) => h.permission),
            excluded,
            codes,
            ADMIN_ACCESS,
            RULE_CHECKED_DECIDERS,
          ]
        )
      )
    ).rows;
  } catch {
    return new Set();
  }
  // Each hold's rows, by its id as the statement returned it (the id the listing passed).
  const byHold = new Map<string, DeciderRow[]>();
  for (const r of rows) byHold.set(r.hold_id, [...(byHold.get(r.hold_id) ?? []), r]);
  const stuck = new Set<string>();
  for (const { p, authority } of holds) {
    const mine = byHold.get(p.proposalId) ?? [];
    const candidates = mine.filter((r) => r.user_id !== null);
    if (candidates.length === 0) {
      stuck.add(p.proposalId);
      continue;
    }
    // The rules' facts read once for this hold, then every candidate decided in memory (round 10,
    // I-C). An authority with rules but no such check is not weighed here: never claimed.
    if (!authority.approverRuleCheck || (mine[0]?.total ?? 0) > RULE_CHECKED_DECIDERS)
      continue;
    let check: Awaited<ReturnType<NonNullable<HoldAuthority["approverRuleCheck"]>>>;
    try {
      check = await authority.approverRuleCheck(p);
    } catch {
      continue; // the rules unreadable: never claimed
    }
    const anyone = candidates.some(
      (c) =>
        !check({
          userId: c.user_id!,
          sub: c.sub ?? "",
          roleName: c.role_name ?? "unknown",
          permissions: c.permissions ?? [],
        })
    );
    if (!anyone) stuck.add(p.proposalId);
  }
  return stuck;
}

/**
 * List every live hold across both mechanisms, newest first. Read-only (040a).
 * A failure in one source is isolated so the other still lists.
 */
export async function listPendingApprovals(
  authorities: readonly HoldAuthority[] = [],
  /**
   * Who is reading (TASK-194 round 2, N2): a hold's summary — the account it acts on, an address
   * among it — is shown only to a viewer who holds the hold's required permission, i.e. one who
   * could decide it; anyone else who may see the queue sees its label and reason only. No viewer:
   * no summaries.
   */
  viewer?: VerifiedAdmin
): Promise<PendingApproval[]> {
  const [proposals, configApprovals] = await Promise.all([
    // Approved holds whose run failed are listed too: a new approval runs them again.
    // And runs whose outcome is unknown, first of all (review 11 H-1): a person must decide them.
    Promise.all([
      getProposalStore().query({ status: "proposed" }),
      getProposalStore().query({ status: "approved" }),
      getProposalStore().query({ status: "indeterminate" }),
    ])
      .then(([open, approved, undecided]): readonly ProposalRecord[] => [
        ...open,
        ...approved,
        ...undecided,
      ])
      .catch((): readonly ProposalRecord[] => []),
    listApprovals({ status: "pending" }).catch((): ConfigApprovalRecord[] => []),
  ]);

  // An approval never used, or a hold never decided, past config.approval_expiry_days, has lapsed
  // and is not offered (review 7 M7, TASK-193; the config.expire-approvals job withdraws it).
  const days = await approvalExpiryDays();
  const owned = proposals.flatMap((p) => {
    if (holdLapsed(p, days)) return [];
    const authority = authorityFor(p, authorities);
    return authority ? [{ p, authority }] : [];
  });
  const runtime = await Promise.all(
    owned.map(async ({ p, authority }): Promise<PendingApproval> => {
      const k = p.payload["key"] ?? p.payload["configKey"];
      const configKey = typeof k === "string" ? k : undefined;
      const requiredPermission = await authority.requiredPermission(p);
      // Only to a viewer who could decide it (N2). Unreadable: listed without it.
      const summary =
        authority.summary && viewer && holds(viewer, requiredPermission)
          ? await authority.summary(p).catch(() => undefined)
          : undefined;
      return {
        source: "runtime",
        id: p.proposalId,
        label: p.label,
        configKey,
        // The person the hold is for (the agent's principal), else the actor.
        requester: p.actor.onBehalfOf ?? p.actor.actorId,
        requiredPermission,
        effectiveRisk: p.effectiveRisk,
        effects: p.effects,
        ...(p.status === "indeterminate" ? { undecided: true } : {}),
        ...(summary ? { summary } : {}),
        reason:
          p.status === "indeterminate"
            ? `Approved and being applied when its run stopped answering: whether it took effect is unknown${
                p.lastRunError ? ` (${p.lastRunError})` : ""
              }. Verify it, then mark it executed — or, if it did not take effect, approve it again or withdraw it.`
            : p.status === "approved"
              ? `Approved, but it could not be applied${
                  p.lastRunError ? ` (${p.lastRunError})` : ""
                } — approve it again to retry, or reject it. It lapses once the approval period has passed.`
              : `Held at effectiveRisk "${p.effectiveRisk}"${
                  p.effects.length ? ` (effects: ${p.effects.join(", ")})` : ""
                } — needs an independent approver.`,
        createdAt: p.createdAt,
      };
    })
  );

  const config = await Promise.all(
    configApprovals.map(async (c): Promise<PendingApproval> => ({
      source: "config-approval",
      id: c.id,
      label: c.configKey,
      configKey: c.configKey,
      requester: c.requestedBy ?? "unknown",
      requiredPermission: await requiredPermissionForKey(c.configKey),
      reason:
        c.impactSummary?.trim() ||
        `Safety-tier change to "${c.configKey}" awaiting a second approver.`,
      createdAt: c.createdAt,
    }))
  );

  // Who may decide the undecided ones (round 7, I-3): for a viewer only — the Approvals screens,
  // never the command bar's context — and in one read for all of them (round 8, item 5).
  const stuck = viewer
    ? await holdsNoOneMayDecide(
        // runtime[i] is owned[i]'s listing (Promise.all keeps the order).
        owned.flatMap(({ p }, i) =>
          p.status === "indeterminate"
            ? [
                {
                  p,
                  authority: owned[i].authority,
                  permission: runtime[i].requiredPermission,
                },
              ]
            : []
        )
      )
    : new Set<string>();
  const marked = runtime.map((r) =>
    stuck.has(r.id) ? { ...r, noEligibleDecider: true as const } : r
  );

  return [...marked, ...config].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
