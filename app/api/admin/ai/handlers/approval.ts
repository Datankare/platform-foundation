/**
 * app/api/admin/ai/handlers/approval.ts — approval-policy action handler (Sprint 3c U1).
 *
 * GenAI-native governance admin (ADR-035) over the A3 approval-policy store. setRules mints a
 * new version (the table is the audit trail); the handler maps the tool input to the store's
 * ApprovalRule shape and delegates the versioning + audit to the store.
 */

import { shown } from "@/platform/errors/shown-text";
import {
  approvalPolicyProblem,
  approvalRulesProblem,
  getApprovalPolicyStore,
  POLICY_DEFAULT_APPROVERS,
} from "@/platform/agents";
import type { ActorType, ApprovalRule } from "@/platform/agents";
import type { EffectType, RiskLevel } from "@/platform/kernel";
import { logger } from "@/lib/logger";
import { coded, runAudited, type ActionResult } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The tool's rules as the store's ApprovalRule shape. */
function rulesOf(input: Record<string, any>): ApprovalRule[] {
  const rawRules: any[] = Array.isArray(input.rules) ? input.rules : [];
  return rawRules.map((r) => ({
    maxRisk: r.max_risk as RiskLevel,
    ...(Array.isArray(r.effects) && r.effects.length > 0
      ? { effects: r.effects as EffectType[] }
      : {}),
    requiredApprover: r.required_approver as ActorType,
  }));
}

/**
 * Why a policy change cannot be made, coded, or null — the store's own check
 * (approvalPolicyProblem, round 12 I-2), applied before the change is held as well as when it
 * runs, so a policy the store would refuse is never held for approval. The default approver, when
 * given, may only be a person ("user": POLICY_DEFAULT_APPROVERS — a restricted action no rule
 * matches falls to it); absent, the current one stands.
 */
export function approvalPolicyInputProblem(
  input: Record<string, any>
): ActionResult | null {
  const rules = rulesOf(input);
  const ruleProblem = approvalRulesProblem(rules);
  if (ruleProblem) {
    return coded("request.invalid_value", { field: "rules", allowed: [ruleProblem] });
  }
  if (approvalPolicyProblem(rules, input.default_approver)) {
    return coded("request.invalid_value", {
      field: "default_approver",
      allowed: [...POLICY_DEFAULT_APPROVERS],
    });
  }
  return null;
}

export async function handleSetApprovalPolicy(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const problem = approvalPolicyInputProblem(input);
  if (problem) return problem;
  const rules = rulesOf(input);
  const defaultApprover = input.default_approver as ActorType | undefined;

  return runAudited(
    {
      action: "admin_action",
      actorId,
      details: {
        type: "set_approval_policy",
        prompt_action: true,
        rules,
        ...(defaultApprover ? { default_approver: defaultApprover } : {}),
      },
    },
    async () => {
      try {
        const policy = await getApprovalPolicyStore().setRules(
          rules,
          actorId,
          defaultApprover
        );
        return {
          success: true,
          // Round 13, I-A: the rules change no current hold — every hold is restricted while the
          // gating threshold is, and a restricted action is always a person's to approve.
          // Its words are the catalog's (round 14, item 11).
          result: shown("screens.admin_console.results.approval_policy_updated", {
            version: policy.version,
            rules: rules.length,
          }),
        };
      } catch (err) {
        // Its text is logged, never returned (TASK-199).
        logger.error("Approval policy could not be saved", {
          error: err instanceof Error ? err.message : String(err),
          route: "app/api/admin/ai/handlers/approval",
        });
        return coded("admin.action_failed");
      }
    }
  );
}
