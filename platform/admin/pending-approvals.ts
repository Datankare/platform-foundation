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
import { authorityFor, type HoldAuthority } from "@/platform/admin/hold-authority";
import { approvalExpiryDays, holdLapsed } from "@/platform/admin/hold-expiry";
import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import { withTenantTx } from "@/platform/data";
import { CONFIG_HOLD_TOOLS } from "@/platform/admin/hold-keys";
import { namedAccounts, type NamedAccount } from "@/platform/admin/account-names";
import { getEnhancedConfig, getPermissionTier } from "@/platform/auth/platform-config";
import { shown, type ShownText } from "@/platform/errors/shown-text";
import { isErrorCode, messageKey, type ErrorCode } from "@/platform/errors/registry";
import {
  ATOMIC_RECOVERED_NOTE,
  INDETERMINATE_NOTE,
} from "@/platform/agents/proposal-store";

/**
 * A run's recorded note as the screen shows it (TASK-206, N-102): a registry code by its sentence,
 * the store's own notes by the catalog's words, anything else as recorded (an operator's note).
 */
export function runNote(note: string): ShownText | string {
  if (isErrorCode(note))
    return shown(messageKey(note as ErrorCode) as `errors.${string}`);
  if (note === INDETERMINATE_NOTE) return shown("screens.held.note_indeterminate");
  if (note === ATOMIC_RECOVERED_NOTE) return shown("screens.held.note_atomic_recovered");
  return note;
}

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
   * The role a held role action names (TASK-202, N-61): the role created, deleted, copied, or
   * whose permissions change; for a role change, the role it moves the account to is `toRole`.
   */
  readonly role?: string;
  /**
   * The permissions a held action grants (TASK-202, N-61): a role created with, added to a role,
   * an entitlement group created with — or, for a role change, those the new role holds that the
   * account's role now does not. Only codes of the permission catalog; at most 100.
   */
  readonly permissionsGranted?: readonly string[];
  /** The permissions a held action takes away (a role's removed, a role change's lost). */
  readonly permissionsRemoved?: readonly string[];
  /** The entitlement group a held action creates, or turns on or off (its code). */
  readonly group?: string;
  /** A held entitlement group turned on (true) or off (false). */
  readonly active?: boolean;
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

/**
 * Who asked for a held change, as a person reads it (TASK-202, N-61): an account by its address
 * and role — never its id; an erased account as erased; an agent or the system by kind. Resolved
 * on the server from the hold's requester (the person an agent acted for, else the actor).
 */
export type RequesterView =
  | {
      readonly kind: "account";
      readonly email: string | null;
      readonly role: string | null;
    }
  | { readonly kind: "erased" }
  | { readonly kind: "unknown" };

/**
 * What a held config change would do (TASK-202, N-61): the key, the value it replaces and the
 * value it would set (a reset: the platform default it would follow again), and where it goes.
 * Given only to a viewer who could decide it, like the summary (round 2, N2).
 */
export interface ConfigChangeView {
  readonly key: string;
  readonly action: "set" | "reset";
  /** The value it replaces, when known (a hold records it; an approval stores it). */
  readonly before?: unknown;
  /** The value it would set (a reset: the default it would follow). */
  readonly after?: unknown;
  readonly scope?: "platform" | "tenant";
}

/** The longest change comment shown with a hold (the request's own bound is larger). */
export const COMMENT_SHOWN_MAX = 500;

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
  /**
   * "Why held", as the catalog's key and values (TASK-206, N-102): the screen words it — never
   * English written here. A failed or undecided run's recorded note is its `detail`: a code's
   * sentence or a run note the catalog has, else the note as recorded (a person's).
   */
  readonly reason: ShownText;
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
  /**
   * Where the hold stands (TASK-202, N-61), for the screen's own words: waiting for its approver
   * (`held`), approved and its run failed (`retry`: approving again retries it), or approved and
   * its outcome unknown (`undecided`). `reason` keeps the server's detail.
   */
  readonly state?: "held" | "retry" | "undecided";
  /** Who asked, by address and role (N-61) — to every viewer of the queue. */
  readonly requestedBy?: RequesterView;
  /** A held config change's key and values (N-61) — only to a viewer who could decide it. */
  readonly change?: ConfigChangeView;
  /** The requester's own comment on the change (N-61) — only to a viewer who could decide it. */
  readonly comment?: string;
  readonly createdAt: string;
}

/** The requester as the screen names it, from the accounts read for the listing. */
function requesterView(
  accounts: ReadonlyMap<string, NamedAccount>,
  requester: string
): RequesterView {
  const found = accounts.get(requester);
  if (!found) return { kind: "unknown" };
  if (found.erased) return { kind: "erased" };
  return { kind: "account", email: found.email, role: found.role };
}

const shownComment = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0
    ? v.trim().slice(0, COMMENT_SHOWN_MAX)
    : undefined;

/**
 * A held config change's key and values (a runtime hold of update_config or reset_config): the
 * value it replaces as recorded when it was held (heldPrevious), else the value now; the value it
 * would set — a reset's, the platform default. Undefined when the hold names no key, or the key
 * is not a setting (an unknown key: the run refuses it, and there is nothing to compare).
 */
async function heldConfigChange(
  p: ProposalRecord
): Promise<ConfigChangeView | undefined> {
  if (!CONFIG_HOLD_TOOLS.has(p.label)) return undefined;
  const key = p.payload["key"];
  if (typeof key !== "string" || !key) return undefined;
  const entry = await getEnhancedConfig(key).catch(() => undefined);
  if (!entry) return undefined;
  const requested = p.payload["scope"];
  const scope =
    requested === "platform" || requested === "tenant" ? requested : undefined;
  const held = p.payload["heldPrevious"];
  const before =
    held && typeof held === "object" && "value" in (held as Record<string, unknown>)
      ? (held as { value: unknown }).value
      : scope === "platform"
        ? entry.platformValue
        : entry.value;
  return p.label === "reset_config"
    ? { key, action: "reset", before, after: entry.platformValue, scope: "tenant" }
    : {
        key,
        action: "set",
        before,
        after: p.payload["value"],
        ...(scope ? { scope } : {}),
      };
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
      const decider = !!viewer && holds(viewer, requiredPermission);
      const summary =
        authority.summary && decider
          ? await authority.summary(p).catch(() => undefined)
          : undefined;
      // A held config change's values and comment (N-61): to a viewer who could decide it.
      const change = decider
        ? await heldConfigChange(p).catch(() => undefined)
        : undefined;
      const comment = decider ? shownComment(p.payload["changeComment"]) : undefined;
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
        state:
          p.status === "indeterminate"
            ? "undecided"
            : p.status === "approved"
              ? "retry"
              : "held",
        ...(summary ? { summary } : {}),
        ...(change ? { change } : {}),
        ...(comment ? { comment } : {}),
        reason:
          p.status === "indeterminate" || p.status === "approved"
            ? shown(
                p.status === "indeterminate"
                  ? "screens.held.reason_undecided"
                  : "screens.held.reason_retry",
                p.lastRunError
                  ? { noted: "yes", detail: runNote(p.lastRunError) }
                  : { noted: "no" }
              )
            : shown("screens.held.reason_held", {
                risk: p.effectiveRisk,
                effects: [...p.effects],
                effected: p.effects.length ? "yes" : "no",
              }),
        createdAt: p.createdAt,
      };
    })
  );

  const config = await Promise.all(
    configApprovals.map(async (c): Promise<PendingApproval> => {
      const requiredPermission = await requiredPermissionForKey(c.configKey);
      // Its values and comment (N-61): to a viewer who could decide it, as a hold's summary.
      const decider = !!viewer && holds(viewer, requiredPermission);
      const comment = decider ? shownComment(c.changeComment) : undefined;
      return {
        source: "config-approval",
        id: c.id,
        label: c.configKey,
        configKey: c.configKey,
        requester: c.requestedBy ?? "unknown",
        requiredPermission,
        state: "held",
        ...(decider
          ? {
              change: {
                key: c.configKey,
                action: c.action,
                before: c.currentValue,
                after: c.proposedValue,
                scope: c.scope,
              },
            }
          : {}),
        ...(comment ? { comment } : {}),
        reason: shown("screens.held.reason_two_person", { key: c.configKey }),
        createdAt: c.createdAt,
      };
    })
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

  // Who asked, by address (N-61): one read for every requester, for a viewer only (the screens;
  // the command bar's context names none).
  const all = [...marked, ...config];
  const accounts = viewer
    ? await namedAccounts(all.map((a) => a.requester))
    : new Map<string, NamedAccount>();
  const named = viewer
    ? all.map((a) => ({ ...a, requestedBy: requesterView(accounts, a.requester) }))
    : all;
  return named.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
