/**
 * app/api/admin/ai/handlers/approval.ts — approval-policy action handler (Sprint 3c U1).
 *
 * GenAI-native governance admin (ADR-035) over the A3 approval-policy store. setRules mints a
 * new version (the table is the audit trail); the handler maps the tool input to the store's
 * ApprovalRule shape and delegates the versioning + audit to the store.
 */

import { getApprovalPolicyStore } from "@/platform/agents";
import { writeAuditLog } from "@/platform/auth/audit";
import type { ActorType, ApprovalRule } from "@/platform/agents";
import type { EffectType, RiskLevel } from "@/platform/kernel";
import type { ActionResult } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function handleSetApprovalPolicy(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const rawRules: any[] = Array.isArray(input.rules) ? input.rules : [];
  const rules: ApprovalRule[] = rawRules.map((r) => ({
    maxRisk: r.max_risk as RiskLevel,
    ...(Array.isArray(r.effects) && r.effects.length > 0
      ? { effects: r.effects as EffectType[] }
      : {}),
    requiredApprover: r.required_approver as ActorType,
  }));

  try {
    const policy = await getApprovalPolicyStore().setRules(rules, actorId);
    await writeAuditLog({
      action: "admin_action",
      actorId,
      details: {
        type: "set_approval_policy",
        prompt_action: true,
        version: policy.version,
        rule_count: rules.length,
      },
    });
    return {
      success: true,
      result: `Approval policy updated (version ${policy.version}, ${rules.length} rule${rules.length === 1 ? "" : "s"})`,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
