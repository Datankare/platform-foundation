/**
 * platform/admin/pending-approvals.ts — the unified pending-approvals read model (ADR-040).
 *
 * Merges the two hold mechanisms into one PendingApproval[] for the admin surface:
 *   - runtime dual-control holds  (proposalStore, status "proposed")
 *   - config-approval two-person  (config_pending_approvals, status "pending")
 * Each carries the permission required to clear it, derived from the config key's
 * permission_tier (fail-closed to safety), per ADR-040's approver model:
 * "you may clear a held change iff you are independently authorized to make it."
 *
 * Read-only (040a). Approve/reject is 040b (POST /api/admin/approvals/[id]).
 */

import type { EffectType, RiskLevel, ProposalRecord } from "@/platform/kernel/types";
import type { ConfigApprovalRecord } from "@/platform/admin/types";
import { getProposalStore } from "@/platform/agents/proposal-store";
import { listApprovals } from "@/platform/admin/config-approval";
import { getPermissionTier } from "@/platform/auth/platform-config";

export type PendingApprovalSource = "runtime" | "config-approval";

/** The permission that authorizes making — and therefore clearing — a held change. */
export type ApprovalPermission = "config_manage_safety" | "config_manage_standard";

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

/** The config key a runtime proposal concerns, if its payload names one (best-effort). */
export function proposalConfigKey(payload: Record<string, unknown>): string | undefined {
  const k = payload["key"] ?? payload["configKey"];
  return typeof k === "string" ? k : undefined;
}

/**
 * List every live hold across both mechanisms, newest first. Read-only (040a).
 * A failure in one source is isolated so the other still lists.
 */
export async function listPendingApprovals(): Promise<PendingApproval[]> {
  const [proposals, configApprovals] = await Promise.all([
    getProposalStore()
      .query({ status: "proposed" })
      .catch((): readonly ProposalRecord[] => []),
    listApprovals({ status: "pending" }).catch((): ConfigApprovalRecord[] => []),
  ]);

  const runtime = await Promise.all(
    proposals.map(async (p): Promise<PendingApproval> => {
      const configKey = proposalConfigKey(p.payload);
      return {
        source: "runtime",
        id: p.proposalId,
        label: p.label,
        configKey,
        requester: p.actor.actorId,
        requiredPermission: await requiredPermissionForKey(configKey),
        effectiveRisk: p.effectiveRisk,
        effects: p.effects,
        reason: `Held at effectiveRisk "${p.effectiveRisk}"${
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
