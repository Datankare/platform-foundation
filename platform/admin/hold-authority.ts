/**
 * platform/admin/hold-authority.ts — Who may clear a runtime hold, and what an approval runs
 * (ADR-040; audit X-10, B-10, C-13, RR-19)
 *
 * A runtime hold is a proposal (platform/agents/proposal-store) for an action the pipeline would
 * not run without an independent approval. Each kind of hold the admin surface can decide has an
 * authority:
 *
 *   - which holds it owns (by the proposal's label and actor);
 *   - the permission an approver must independently hold — the permission needed to make the
 *     change directly ("you may clear a held change iff you are authorized to make it");
 *   - how an approved hold is run, at once, exactly once (the pipeline claims the approval).
 *
 * Before: every runtime hold required config_manage_safety, so a safety approver could clear a
 * held role change or agent registration they could never make themselves (B-10); and only a held
 * config change was ever run — an approved command-bar action never ran (RR-19, C-13).
 *
 * A hold no authority owns — an agent's workflow step, held for its own user (ADR-030) — is not
 * the admin surface's to decide: it is neither listed nor decidable here, and its owner decides
 * it through the app's agent-approval route (heldActionRefusal: ownership and independence).
 *
 * The platform owns the config tools' holds (CONFIG_HOLDS). An app adds the authorities for the
 * holds its own code makes (PF's command bar: app/api/admin/ai/command-bar-holds.ts) by passing
 * them to listPendingApprovals and decideApproval.
 *
 * @module platform/admin
 */

import type { ProposalRecord } from "@/platform/kernel/types";
import { getEnhancedConfig, getPermissionTier } from "@/platform/auth/platform-config";
import { runApprovedConfigChange } from "@/platform/admin/config-handlers";
import {
  ActionNotRecordedError,
  ApprovedRunFailedError,
  PipelineRejectedError,
} from "@/platform/action-pipeline";
import {
  approvedChangeTarget,
  isSharedDeployment,
  resolveConfigTarget,
} from "@/platform/admin/config-scope";
import type { ConfigScope } from "@/platform/admin/types";
import { CONFIG_HOLD_TOOLS, proposalConfigKey } from "@/platform/admin/hold-keys";
import { isStaleChangeFailure } from "@/platform/admin/stale-change";
import { HeldActionNotApprovedError } from "@/platform/agents/workflow-loop";

/** What running an approved hold did. */
export type HoldResumeResult =
  /** It took effect. `unrecorded`: and its record could not be stored (review 10 M5) — said so. */
  | { readonly kind: "applied"; readonly unrecorded?: string }
  /** Applied as far as this approval goes; the change now waits for another (two-person). */
  | { readonly kind: "pending"; readonly approval?: unknown }
  /**
   * It did not take effect. `approvalKept`: the run failed after claiming the approval and the
   * claim was released (review 10 H2) — approving again retries it.
   */
  | { readonly kind: "failed"; readonly error: string; readonly approvalKept?: boolean }
  /** Another run holds the approval, or it was used: it runs once (409). */
  | { readonly kind: "in_use"; readonly error: string }
  /**
   * The value it would replace changed since it was requested (review 12 H2): nothing was
   * changed; the hold is withdrawn and the requester must ask again (approvals.stale, 409).
   */
  | { readonly kind: "stale"; readonly error: string };

export interface HoldAuthority {
  /** Stable name, for logs and audit records. */
  readonly name: string;
  /** Whether this authority decides `proposal`. */
  owns(proposal: ProposalRecord): boolean;
  /** The permission an approver of `proposal` must hold (fails closed: the strictest). */
  requiredPermission(proposal: ProposalRecord): Promise<string>;
  /**
   * Why an approver with this operator standing may not approve `proposal` beyond the permission
   * (a shared deployment's platform default is an operator's to approve), or undefined.
   */
  approverRefusal?(
    proposal: ProposalRecord,
    approverIsOperator: boolean
  ): Promise<string | undefined>;
  /** Run the approved hold. Called once its approval is recorded. */
  resume(proposal: ProposalRecord): Promise<HoldResumeResult>;
}

/**
 * What an approved run's error means to the decision (review 10 H2): in use or used (409 — it
 * runs once), failed before taking effect with the approval kept (approve again to retry), or
 * applied with its record not stored (applied — and said so).
 */
export function resumeFailure(err: unknown): HoldResumeResult {
  // A workflow resume that lost the approval's claim to another run (TASK-175) is in use too.
  if (
    (err instanceof PipelineRejectedError && err.reason === "approval-used") ||
    err instanceof HeldActionNotApprovedError
  ) {
    return { kind: "in_use", error: err.message };
  }
  if (err instanceof ApprovedRunFailedError) {
    if (isStaleChangeFailure(err.reason)) return { kind: "stale", error: err.reason };
    return { kind: "failed", error: err.message, approvalKept: true };
  }
  if (err instanceof ActionNotRecordedError && err.applied) {
    return { kind: "applied", unrecorded: err.message };
  }
  return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
}

export { CONFIG_HOLD_TOOLS, proposalConfigKey } from "@/platform/admin/hold-keys";

/**
 * A config write held under dual control (ADR-039 F2b-2) — the one hold on a change to a
 * dual-controlled key, whichever surface asked for it (the config page, the config assistant,
 * the command bar's config-writing actions; review 10 H1): permission by the key's tier, and for
 * a shared deployment's platform default (or a tenant's value of a key only operators may set)
 * an operator.
 */
export const CONFIG_HOLDS: HoldAuthority = {
  name: "config",
  owns: (proposal) => CONFIG_HOLD_TOOLS.has(proposal.label),
  async requiredPermission(proposal) {
    const key = proposalConfigKey(proposal.payload);
    // No key: the strictest (getPermissionTier fails closed to safety as well).
    if (!key) return "config_manage_safety";
    return (await getPermissionTier(key)) === "standard"
      ? "config_manage_standard"
      : "config_manage_safety";
  },
  async approverRefusal(proposal, approverIsOperator) {
    const key = proposalConfigKey(proposal.payload);
    const entry = key ? await getEnhancedConfig(key) : undefined;
    if (!entry) return undefined; // the run refuses an unknown key itself
    const requested = proposal.payload["scope"];
    // Where the held change goes, as its requester asked; the approver must be able to approve a
    // change there — as for a held config approval (approvedChangeTarget): in a shared
    // deployment, a platform default, or a tenant's own value of a key only operators may set, is
    // an operator's to approve.
    let scope: ConfigScope;
    if (proposal.label === "reset_config") {
      scope = "tenant";
    } else {
      const target = resolveConfigTarget(
        proposal.payload["actorIsOperator"] === true,
        entry,
        requested === "platform" || requested === "tenant" ? requested : undefined
      );
      if (!target.ok) return target.reason;
      scope = target.target.scope;
    }
    if (isSharedDeployment() && scope === "tenant" && !entry.tenantOverridable) {
      if (!approverIsOperator)
        return `"${entry.key}" governs the platform; only an operator can approve it.`;
    }
    const approved = approvedChangeTarget(approverIsOperator, scope);
    return approved.ok ? undefined : approved.reason;
  },
  async resume(proposal) {
    let applied;
    try {
      applied = await runApprovedConfigChange(proposal.proposalId);
    } catch (err) {
      return resumeFailure(err);
    }
    if (!applied) return { kind: "failed", error: "not a held config change" };
    const data = (applied.data ?? {}) as {
      applied?: boolean;
      requiresApproval?: boolean;
      approval?: unknown;
      error?: string;
      stale?: boolean;
    };
    if (data.stale) {
      return { kind: "stale", error: applied.error ?? data.error ?? "the value changed" };
    }
    if (applied.success && data.applied) return { kind: "applied" };
    if (applied.success && data.requiresApproval) {
      return { kind: "pending", approval: data.approval };
    }
    return {
      kind: "failed",
      error: applied.error ?? data.error ?? "the change was not applied",
    };
  },
};

/** The platform's own authorities; an app passes its own alongside. */
export const PLATFORM_HOLD_AUTHORITIES: readonly HoldAuthority[] = [CONFIG_HOLDS];

/** The authority that decides `proposal`, or undefined when none does. */
export function authorityFor(
  proposal: ProposalRecord,
  extra: readonly HoldAuthority[] = []
): HoldAuthority | undefined {
  return [...PLATFORM_HOLD_AUTHORITIES, ...extra].find((a) => a.owns(proposal));
}
