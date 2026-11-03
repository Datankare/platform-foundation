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

import { logger } from "@/lib/logger";
import type { ProposalRecord } from "@/platform/kernel/types";
import type { ErrorCode, ErrorParams } from "@/platform/errors";
import { isErrorCode } from "@/platform/errors/registry";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import { getEnhancedConfig, getPermissionTier } from "@/platform/auth/platform-config";
import {
  codedConfigFailure,
  runApprovedConfigChange,
} from "@/platform/admin/config-handlers";
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
import type { HeldActionSummary } from "@/platform/admin/pending-approvals";
import { CONFIG_HOLD_TOOLS, configToolTargetKey } from "@/platform/admin/hold-keys";
import { isStaleChangeFailure } from "@/platform/admin/stale-change";
import { HeldActionNotApprovedError } from "@/platform/agents/workflow-loop";

/** What running an approved hold did. */
export type HoldResumeResult =
  /** It took effect. `unrecorded`: and its record could not be stored (review 10 M5) — said so. */
  | { readonly kind: "applied"; readonly unrecorded?: string }
  /** Applied as far as this approval goes; the change now waits for another (two-person). */
  | { readonly kind: "pending"; readonly approval?: unknown }
  /**
   * It did not take effect. `approvalKept`: true — the run failed after claiming the approval and
   * the claim was released (review 10 H2): approving again retries it; false — the claim was not
   * given back (its write lost its commit and may stand, round 16 item 1, or the release could
   * not be written): undecided once its lease has passed, for a person to decide; undefined — no
   * claim was taken (the run never started: the approval stands as it was).
   */
  | {
      readonly kind: "failed";
      readonly error: string;
      readonly approvalKept?: boolean;
      /**
       * Why, as a registry code, when the run said (round 14, item 1): a change to the key
       * already waiting for two-person approval, the audit log unavailable, a lost commit. The
       * decision answers it; absent, `approvals.run_failed`.
       */
      readonly code?: ErrorCode;
      readonly params?: ErrorParams;
    }
  /** Another run holds the approval, or it was used: it runs once (409). */
  | { readonly kind: "in_use"; readonly error: string }
  /**
   * The value it would replace changed since it was requested (review 12 H2): nothing was
   * changed, and the requester must ask again (approvals.stale, 409). Only when the run's claim was
   * given back (`released !== false`, round 21 I-1); withdrawn by the decision, as the system, when
   * the withdrawal lands — and said so (`withdrawn: true`).
   */
  | { readonly kind: "stale"; readonly error: string }
  /**
   * Refused as it stands now, for good (TASK-194 round 20, residual A): a change to a required
   * job's enabled key (`jobs.schedule_required`) — filed before the job was required. Nothing was
   * changed; approving it again could only fail the same way. Only when the run's claim was given
   * back (`released !== false`, round 21 I-1); withdrawn by the decision, as the system and
   * recorded (reason `refused`), when the withdrawal lands — said `withdrawn: true` — and the code
   * answered either way.
   */
  | {
      readonly kind: "refused";
      readonly error: string;
      readonly code: ErrorCode;
      readonly params?: ErrorParams;
    };

/** The codes that refuse a held change for good: withdrawn, never kept (round 20, residual A). */
export const WITHDRAWN_ON_RESUME: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "jobs.schedule_required",
]);

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
  /**
   * The change's own rules, evaluated for the APPROVER against the held payload (TASK-194, audit
   * C-2): "you may clear a held change iff you are authorized to make it" includes the rules the
   * change applies beyond its permission — a role change needs every permission of both roles,
   * and never a protected role; a catalog change needs the standing to change the catalog. The
   * coded refusal, or undefined. A read error throws (the decision fails closed). Checked on
   * every decision that makes the change take effect or declares it done (approve, reapprove,
   * mark_executed) — not on a rejection or a withdrawal, which never run it. (Whose account it
   * is — targetAccount, A3 — binds every decision, those two included: round 6, I-1, P-1.)
   */
  approverRuleRefusal?(
    proposal: ProposalRecord,
    approver: VerifiedAdmin
  ): Promise<{ readonly code: ErrorCode; readonly params: ErrorParams } | undefined>;
  /**
   * The same rules, split (round 10, I-C): what they read for this held action, read once, and
   * a pure check of any approver against it — for weighing many possible deciders at once
   * (pending-approvals noEligibleDecider) with one read per hold. approverRuleRefusal is this
   * check for one approver. A read error throws.
   */
  approverRuleCheck?(
    proposal: ProposalRecord
  ): Promise<
    (
      approver: VerifiedAdmin
    ) => { readonly code: ErrorCode; readonly params: ErrorParams } | undefined
  >;
  /**
   * The account (users.id) the held action acts on, when it acts on one (TASK-194 round 1, A3): a
   * decider is never it, whatever the action and whatever the decision — approve, reapprove,
   * mark_executed, withdraw or reject (round 6, I-1, P-1). `null`: it names an account that is not
   * found (not the approver's, whose account exists; the run reports it). A read error throws (fail
   * closed).
   */
  targetAccount?(proposal: ProposalRecord): Promise<string | null | undefined>;
  /**
   * Another open hold this undecided one duplicates, if any (TASK-199): the hold kept (an older one
   * of the same action on the same subject), and the code a decision on the duplicate answers.
   * decideApproval rejects the duplicate — the system's decision, recorded — instead of approving
   * it; an undecided run (indeterminate) that duplicates one is never approved again (TASK-194
   * round 5: it would run twice) — answered approvals.duplicate_undecided (round 8), nothing
   * changed. A read error throws (fail closed: no decision).
   */
  duplicateOf?(
    proposal: ProposalRecord
  ): Promise<{ readonly holdId: string; readonly code: ErrorCode } | undefined>;
  /** What the held action would do, for its approver — server-built, allowlisted (A1). */
  summary?(proposal: ProposalRecord): Promise<HeldActionSummary | undefined>;
  /**
   * Run the approved hold. Called once its approval is recorded.
   *
   * @external It runs whatever action the hold is — an erasure reaches the identity provider —
   * so an audited act that calls it is marked external (round 9, P-1;
   * __tests__/helpers/audited-external-scan.ts reads the tag through the interface).
   */
  resume(proposal: ProposalRecord): Promise<HoldResumeResult>;
}

/**
 * What an approved run's error means to the decision (review 10 H2): in use or used (409 — it
 * runs once), failed before taking effect — with the approval kept when its claim was released
 * (approve again to retry), and the run's own registry code when it gave one (TASK-194 round 15,
 * I-1: a change already waiting, the audit log unavailable, a lost commit) — or applied with its
 * record not stored (applied — and said so). Stale or refused for good (a required job's key) only
 * when its claim was given back (`released !== false`, round 21 I-1): the decision then withdraws
 * it, as the system, and says `withdrawn: true` when the withdrawal lands; a claim kept is
 * `failed`, `approvalKept: false` — a run whose outcome is unknown. Every error's own text — a
 * reason may be a store's message — is logged, never carried (round 15, I-5).
 */
export function resumeFailure(err: unknown): HoldResumeResult {
  const logged = (what: string) =>
    logger.error(what, {
      error: err instanceof Error ? err.message : String(err),
      route: "platform/admin/hold-authority",
    });
  // A workflow resume that lost the approval's claim to another run (TASK-175) is in use too.
  if (
    (err instanceof PipelineRejectedError && err.reason === "approval-used") ||
    err instanceof HeldActionNotApprovedError
  ) {
    logged("Approved held change not run: its approval is in use or used");
    return { kind: "in_use", error: "Another run holds this approval, or it was used." };
  }
  if (err instanceof ApprovedRunFailedError) {
    const code = err.failure?.code;
    // Stale, or refused for good — each withdrawn by the decision — only when the run's claim was
    // given back (round 21, I-1): a claim kept (released false) is a run whose outcome is not
    // known, a person's to decide once its lease has passed — never withdrawn as refused.
    if (err.released !== false) {
      // The stale code (STALE_CHANGE_CODE) is the reason itself: fixed text.
      if (isStaleChangeFailure(err.reason)) return { kind: "stale", error: err.reason };
      if (code && isErrorCode(code) && WITHDRAWN_ON_RESUME.has(code)) {
        // A refusal, not a fault (round 21, nit 6): a warning; the decision withdraws it.
        logger.warn("Approved held change refused for good", {
          code,
          error: err.message,
          route: "platform/admin/hold-authority",
        });
        return {
          kind: "refused",
          error: "The approved change is refused as it stands now.",
          code,
          params: { ...(err.failure?.params ?? {}) } as ErrorParams,
        };
      }
    }
    logged("Approved held change failed before taking effect");
    return {
      kind: "failed",
      error: "The approved change was not applied.",
      approvalKept: err.released,
      ...(code &&
      isErrorCode(code) &&
      code !== "admin.action_failed" &&
      code !== "internal.error"
        ? { code, params: { ...(err.failure?.params ?? {}) } as ErrorParams }
        : {}),
    };
  }
  if (err instanceof ActionNotRecordedError && err.applied) {
    logged("Approved held change applied; its record could not be stored");
    return {
      kind: "applied",
      unrecorded: "Applied, but its record could not be stored.",
    };
  }
  logged("Approved held change failed");
  return { kind: "failed", error: "The approved change failed." };
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
    // The key the held tool acts on (CONFIG_TOOL_TARGET_FIELD, audit C-1).
    const key = configToolTargetKey(proposal.label, proposal.payload);
    // No key: the strictest (getPermissionTier fails closed to safety as well).
    if (!key) return "config_manage_safety";
    return (await getPermissionTier(key)) === "standard"
      ? "config_manage_standard"
      : "config_manage_safety";
  },
  async approverRefusal(proposal, approverIsOperator) {
    const key = configToolTargetKey(proposal.label, proposal.payload);
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
      approvalError?: string;
      error?: string;
      stale?: boolean;
    };
    if (data.stale) {
      return { kind: "stale", error: applied.error ?? data.error ?? "the value changed" };
    }
    if (applied.success && data.applied) return { kind: "applied" };
    // Pending only when it was filed (round 13, P-1): a filing refused — another change to the
    // key already waiting — is no pending approval, and the change failed.
    if (applied.success && data.requiresApproval && !data.approvalError) {
      return { kind: "pending", approval: data.approval };
    }
    const coded = codedConfigFailure(applied);
    if (coded && WITHDRAWN_ON_RESUME.has(coded.code))
      return {
        kind: "refused",
        error: applied.error ?? data.error ?? "refused",
        code: coded.code,
        params: coded.params as ErrorParams,
      };
    return {
      kind: "failed",
      error:
        applied.error ?? data.approvalError ?? data.error ?? "the change was not applied",
      ...(coded ? { code: coded.code, params: coded.params as ErrorParams } : {}),
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
