/**
 * platform/admin/lapsed-hold.ts — withdrawing a hold whose period ran out (TASK-193; shared by
 * TASK-194's rebase, I-3)
 *
 * An approval never used, past config.approval_expiry_days, is withdrawn — and a hold never
 * decided is rejected (TASK-193, audit B-4) — by the system (HOLD_EXPIRY_ACTOR), recorded before
 * it is made (approval_withdrawn, reason "expired"), naming who or what found it lapsed. Its
 * trajectory ends with it. Two callers: a decision on the hold (approval-decision.ts: it answers
 * approvals.expired), and a new erasure request finding the account's open erasure hold lapsed
 * (app/api/admin/gdpr/route.ts: the lapsed hold no longer stands in its way — the one-open-erasure
 * index, 061, counts it until it is withdrawn).
 *
 * @module platform/admin
 */

import type { ProposalRecord } from "@/platform/kernel/types";
import { audited } from "@/platform/auth/audit";
import { getProposalStore } from "@/platform/agents/proposal-store";
import { settleHeldTrajectory } from "@/platform/agents/gating";
import { getTrajectoryStore } from "@/platform/agents/trajectory-store";
import {
  HOLD_EXPIRY_ACTOR,
  lapsedNote,
  undecidedNote,
} from "@/platform/admin/hold-expiry";

/**
 * Withdraw `proposal` (approved: withdrawn; proposed: rejected) as lapsed after `days`, recorded
 * first. True when this call withdrew it; false when it was already used or decided. Throws
 * AuditWriteError when the record cannot be written (nothing is withdrawn).
 */
export async function withdrawLapsedHold(args: {
  readonly proposal: ProposalRecord;
  readonly days: number;
  readonly source: "runtime";
  readonly foundBy: string;
}): Promise<boolean> {
  const { proposal, days, source, foundBy } = args;
  const undecided = proposal.status === "proposed";
  const outcome = await audited(
    {
      action: "admin_action",
      agent: HOLD_EXPIRY_ACTOR,
      details: {
        type: "approval_withdrawn",
        reason: "expired",
        holdId: proposal.proposalId,
        source,
        label: proposal.label,
        ...(undecided
          ? { decision: "undecided", requestedAt: proposal.createdAt }
          : {
              approvedBy: proposal.decidedBy ?? null,
              approvedAt: proposal.decidedAt ?? null,
            }),
        foundBy,
      },
    },
    async () => {
      const withdrawn = undecided
        ? await getProposalStore().decide(
            proposal.proposalId,
            "rejected",
            HOLD_EXPIRY_ACTOR,
            undecidedNote(days)
          )
        : await getProposalStore().withdraw(
            proposal.proposalId,
            HOLD_EXPIRY_ACTOR,
            lapsedNote(days)
          );
      // Its trajectory ends with it (TASK-193); best effort, as every settle.
      await Promise.resolve()
        .then(() => settleHeldTrajectory(getTrajectoryStore(), withdrawn))
        .catch(() => undefined);
      return withdrawn
        ? { success: true as const }
        : { success: false as const, error: "already used or decided" };
    }
  );
  return outcome.success;
}
