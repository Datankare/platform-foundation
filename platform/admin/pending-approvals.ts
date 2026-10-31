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

export { proposalConfigKey } from "@/platform/admin/hold-authority";

export type PendingApprovalSource = "runtime" | "config-approval";

/** The permission that authorizes making — and therefore clearing — a held change. */
export type ApprovalPermission = string;

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
   * verifying it took effect) or "reapprove" (after verifying it did not) — never approve/reject.
   */
  readonly undecided?: boolean;
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

/**
 * List every live hold across both mechanisms, newest first. Read-only (040a).
 * A failure in one source is isolated so the other still lists.
 */
export async function listPendingApprovals(
  authorities: readonly HoldAuthority[] = []
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
      return {
        source: "runtime",
        id: p.proposalId,
        label: p.label,
        configKey,
        // The person the hold is for (the agent's principal), else the actor.
        requester: p.actor.onBehalfOf ?? p.actor.actorId,
        requiredPermission: await authority.requiredPermission(p),
        effectiveRisk: p.effectiveRisk,
        effects: p.effects,
        ...(p.status === "indeterminate" ? { undecided: true } : {}),
        reason:
          p.status === "indeterminate"
            ? `Approved and being applied when its run stopped answering: whether it took effect is unknown${
                p.lastRunError ? ` (${p.lastRunError})` : ""
              }. Verify it, then mark it executed — or, if it did not take effect, approve it again.`
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

  return [...runtime, ...config].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
