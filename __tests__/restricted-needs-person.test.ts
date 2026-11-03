/**
 * @jest-environment node
 */
/**
 * __tests__/restricted-needs-person.test.ts — restricted ⇒ person (TASK-194 round 13, I-A;
 * ADR-030 amendment of 2026-10-31, ADR-040 addendum)
 *
 * The decision: a held action whose risk is `restricted`, or whose effects include `restricted`,
 * is always approved by a person, whatever the approval policy's rules or default say. This
 * asserts it for every way a hold can be restricted and every policy that could say otherwise:
 *
 *   - the threshold: every hold is at GATING_THRESHOLD, which is `restricted` (were it lowered,
 *     the ADR says what the policy then decides — this test says so too);
 *   - every held label: a held command-bar action and a held config change are restricted;
 *   - every effect set (each subset of the policy's effects) at restricted risk, and every risk
 *     with the `restricted` effect, under every hostile policy — a non-person default, and rules
 *     naming an agent or the system at every risk and effect — resolves to "user", through the
 *     resolver, the gate's approvalPolicy and heldActionRefusal (an agent decider refused);
 *   - neither store takes such a policy, and a stored one is read with a person as its default.
 */

import {
  GATING_THRESHOLD,
  type EffectType,
  type ProposalRecord,
  type RiskLevel,
} from "@/platform/kernel/types";
import {
  APPROVERS,
  InMemoryApprovalPolicyStore,
  POLICY_EFFECTS,
  RISK_ORDER,
  approvalPolicyProblem,
  resolveApprover,
  type ApprovalPolicy,
  type ApprovalRule,
} from "@/platform/agents/approval-policy-store";
import { approvalPolicy, heldActionRefusal } from "@/platform/agents/gating";
import { COMMAND_BAR_HANDLERS, runtimeToolFor } from "@/app/api/admin/ai/command-bar";
import { CONFIG_TOOLS, heldConfigTool } from "@/platform/admin/config-handlers";
import { computeEffectiveRisk } from "@/platform/action-pipeline/risk";
import type { AdminToolId } from "@/app/api/admin/ai/tool-permissions";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";

const ADMIN = {
  userId: "00000000-0000-4000-8000-0000000000a1",
  sub: "s",
  roleName: "super_admin",
  permissions: [],
} as unknown as VerifiedAdmin;

const EFFECT_SETS: EffectType[][] = (() => {
  const all = POLICY_EFFECTS as readonly EffectType[];
  const out: EffectType[][] = [];
  for (let mask = 0; mask < 1 << all.length; mask += 1)
    out.push(all.filter((_, i) => mask & (1 << i)));
  return out;
})();

/** Every restricted (risk, effects) a hold can carry. */
const RESTRICTED: [RiskLevel, EffectType[]][] = [
  ...EFFECT_SETS.map((e) => ["restricted", e] as [RiskLevel, EffectType[]]),
  ...RISK_ORDER.flatMap((risk) =>
    EFFECT_SETS.filter((e) => e.includes("restricted" as EffectType)).map(
      (e) => [risk, e] as [RiskLevel, EffectType[]]
    )
  ),
];

/** Policies that would name someone other than a person, by default or by any rule. */
const HOSTILE: ApprovalPolicy[] = [
  ...APPROVERS.filter((a) => a !== "user").map(
    (a) => ({ version: 2, default: a, rules: [] }) as ApprovalPolicy
  ),
  ...APPROVERS.filter((a) => a !== "user").flatMap((a) =>
    RISK_ORDER.flatMap((risk) =>
      EFFECT_SETS.map(
        (effects) =>
          ({
            version: 3,
            default: a,
            rules: [
              {
                maxRisk: risk,
                ...(effects.length ? { effects } : {}),
                requiredApprover: a,
              } as ApprovalRule,
            ],
          }) as ApprovalPolicy
      )
    )
  ),
];

describe("restricted ⇒ person (ADR-030/ADR-040, TASK-194)", () => {
  it("every hold is restricted: the gating threshold is restricted", () => {
    // Lowering it brings actions below restricted to a hold, where the policy decides — an ADR
    // decision (ADR-030 amendment of 2026-10-31), not a constant to change in passing.
    expect(GATING_THRESHOLD).toBe("restricted");
  });

  // Round 14, item 6: the form each held-able tool is held with, by its effective risk —
  // computed as the pipeline computes it (max of the declared risk and the effects' floor).
  it.each(
    (Object.keys(COMMAND_BAR_HANDLERS) as AdminToolId[]).filter((t) => t !== "search")
  )("command bar: %s is held at restricted", (tool) => {
    const held = runtimeToolFor(tool, {}, ADMIN, true);
    expect(
      computeEffectiveRisk({
        type: held.id,
        effects: held.effects,
        declaredRisk: held.declaredRisk,
        ephemeral: false,
        commutative: false,
      })
    ).toBe("restricted");
  });

  it.each(CONFIG_TOOLS.map((t) => t.id))(
    "config assistant: %s is held at restricted",
    (id) => {
      const held = heldConfigTool(CONFIG_TOOLS.find((t) => t.id === id)!);
      expect(
        computeEffectiveRisk({
          type: held.id,
          effects: held.effects,
          declaredRisk: held.declaredRisk,
          ephemeral: false,
          commutative: false,
        })
      ).toBe("restricted");
    }
  );

  it(`resolves a person for every restricted hold under every hostile policy (${RESTRICTED.length} holds)`, () => {
    const wrong: string[] = [];
    for (const policy of HOSTILE)
      for (const [risk, effects] of RESTRICTED) {
        if (resolveApprover(policy, risk, effects).actorType !== "user")
          wrong.push(`resolver ${risk} ${effects} ${JSON.stringify(policy)}`);
        if (approvalPolicy(risk, effects, policy).actorType !== "user")
          wrong.push(`gate ${risk} ${effects} ${JSON.stringify(policy)}`);
      }
    expect(wrong).toEqual([]);
  });

  it("an agent may not approve a restricted hold under any hostile policy; its person may", () => {
    const proposer = {
      actorType: "agent" as const,
      actorId: "agent-a",
      agentRole: "assistant",
      onBehalfOf: "u1",
      sessionId: "s-proposer",
    };
    const agent = { ...proposer, actorId: "agent-b", sessionId: "s-decider" };
    const person = {
      actorType: "user" as const,
      actorId: "u1",
      agentRole: "user",
      sessionId: "s-decider",
    };
    const wrong: string[] = [];
    for (const policy of HOSTILE)
      for (const [risk, effects] of RESTRICTED) {
        const held = {
          proposalId: "p1",
          status: "proposed",
          actor: proposer,
          effectiveRisk: risk,
          effects,
        } as unknown as ProposalRecord;
        if (heldActionRefusal(held, agent, "approve", policy) !== "approver_not_allowed")
          wrong.push(`agent ${risk} ${effects}`);
        if (heldActionRefusal(held, person, "approve", policy) !== null)
          wrong.push(`person ${risk} ${effects}`);
      }
    expect(wrong).toEqual([]);
  });

  it("no store takes a policy that names another approver for a restricted action, or as default", async () => {
    const store = new InMemoryApprovalPolicyStore();
    for (const policy of HOSTILE) {
      const covers = policy.rules.some(
        (r) =>
          r.maxRisk === "restricted" ||
          (r.effects ?? []).includes("restricted" as EffectType)
      );
      // Every hostile policy is refused: by its default, and — where a rule covers a restricted
      // action — by that rule.
      expect(approvalPolicyProblem(policy.rules, policy.default)).not.toBeNull();
      if (covers) expect(approvalPolicyProblem(policy.rules)).not.toBeNull();
      await expect(
        store.setRules(policy.rules, "admin", policy.default)
      ).rejects.toThrow();
    }
    const handSet = new InMemoryApprovalPolicyStore({
      version: 7,
      default: "agent",
      rules: [],
    });
    expect((await handSet.load()).default).toBe("user");
  });
});
