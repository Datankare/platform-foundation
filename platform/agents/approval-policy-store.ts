/**
 * platform/agents/approval-policy-store.ts — Admin-governed approval policy (Sprint 3c, A1)
 *
 * Sprint 3b's gating contract makes the approver a typed AgentIdentity and human review the
 * P10 default, hardcoded in gating.ts approvalPolicy(). A1 replaces the hardcode with a
 * durable, VERSIONED policy this store owns: an ordered rule list mapping an action class
 * (risk + effects) to the actorType required to approve it, plus a default.
 *
 * A1 ships the CONTRACT + an in-memory implementation + the pure resolver. The policy is
 * behavior-preserving by default (default: "user", no rules → human approves everything),
 * so nothing changes until an admin adds a rule. A3 adds the durable (Supabase) store and
 * the versioned, audited setRules mutation; A2 is the conformance kit every implementation
 * must pass; A4 is the admin route that calls setRules. This file pre-empts none of them.
 *
 * GenAI Principles: P10 (human oversight is the default), P13 (bounded autonomy governed
 * centrally), P17 (a policy change is a commitment), P3/P18 (versioned, reconstructable).
 *
 * @module platform/agents
 */

import type { AgentIdentity, EffectType, RiskLevel } from "@/platform/kernel";
import { getSingleton, setSingleton } from "@/platform/kernel";

/** The actor type an approval requires — the three legal AgentIdentity.actorType values. */
export type ActorType = AgentIdentity["actorType"];

/** Risk ordering, lowest → highest. Mirrors the workflow-loop / pipeline computation. */
const RISK_ORDER: readonly RiskLevel[] = ["ordinary", "consequential", "restricted"];

/**
 * One rule. A held action MATCHES this rule when its effectiveRisk is at or below `maxRisk`
 * AND (if `effects` is given) every listed effect is present on the action. First matching
 * rule in policy order wins; if none match, the policy `default` applies.
 */
export interface ApprovalRule {
  readonly maxRisk: RiskLevel;
  readonly effects?: readonly EffectType[];
  readonly requiredApprover: ActorType;
}

/** The full policy. Versioned so a change is an auditable event (A3), not a silent edit. */
export interface ApprovalPolicy {
  readonly version: number;
  readonly default: ActorType;
  readonly rules: readonly ApprovalRule[];
}

/**
 * The store contract. A1 provides InMemoryApprovalPolicyStore; A3 provides the Supabase
 * implementation; both must pass A2's conformance kit. `setRules` bumps the version and
 * records who decided — the durable store makes that atomic and audited (A3).
 */
export interface ApprovalPolicyStore {
  /** The current policy. Never null: an unset store returns the default policy. */
  load(): Promise<ApprovalPolicy>;
  /** Replace the rule list, bumping version. `decidedBy` is the deciding actor id (A3 audits). */
  setRules(rules: readonly ApprovalRule[], decidedBy: string): Promise<ApprovalPolicy>;
}

/**
 * The behavior-preserving default: human approves everything (P10). Identical in effect to
 * Sprint 3b's hardcoded approvalPolicy(). version 1, no rules → resolveApprover always
 * returns the default actorType "user".
 */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  version: 1,
  default: "user",
  rules: [],
};

function riskAtOrBelow(actionRisk: RiskLevel, maxRisk: RiskLevel): boolean {
  return RISK_ORDER.indexOf(actionRisk) <= RISK_ORDER.indexOf(maxRisk);
}

function effectsPresent(
  ruleEffects: readonly EffectType[] | undefined,
  actionEffects: readonly EffectType[]
): boolean {
  if (!ruleEffects || ruleEffects.length === 0) return true;
  return ruleEffects.every((e) => actionEffects.includes(e));
}

/**
 * Resolve the required approver for a held action, PURELY, against a given policy. First
 * rule whose risk bound and effects both match wins; otherwise the policy default. Returns
 * the same AgentIdentity shape the gating contract already uses — the concrete actorId/role
 * of a human approver stays a consumer concern; what the policy fixes is the actorType.
 */
export function resolveApprover(
  policy: ApprovalPolicy,
  effectiveRisk: RiskLevel,
  effects: readonly EffectType[]
): AgentIdentity {
  const matched = policy.rules.find(
    (r) => riskAtOrBelow(effectiveRisk, r.maxRisk) && effectsPresent(r.effects, effects)
  );
  const actorType = matched ? matched.requiredApprover : policy.default;
  return {
    actorType,
    actorId: actorType === "user" ? "pending-human-approver" : "pending-approver",
    agentRole: "approver",
  };
}

/** In-memory policy store. The A1 default implementation; swapped for Supabase in A3. */
export class InMemoryApprovalPolicyStore implements ApprovalPolicyStore {
  private policy: ApprovalPolicy;

  constructor(initial: ApprovalPolicy = DEFAULT_APPROVAL_POLICY) {
    this.policy = initial;
  }

  async load(): Promise<ApprovalPolicy> {
    return this.policy;
  }

  async setRules(
    rules: readonly ApprovalRule[],
    _decidedBy: string
  ): Promise<ApprovalPolicy> {
    this.policy = {
      version: this.policy.version + 1,
      default: this.policy.default,
      rules,
    };
    return this.policy;
  }
}

const STORE_KEY = "platform.agents.approvalPolicyStore";

/**
 * The process-wide approval-policy store. Anchored on the kernel singleton registry
 * (globalThis via Symbol.for, ADR-032) so every request in a bundle-duplicated module copy
 * reads the same instance. Returns the in-memory default until A3 registers a durable store
 * via setSingleton.
 */
export function getApprovalPolicyStore(): ApprovalPolicyStore {
  return getSingleton(STORE_KEY, () => new InMemoryApprovalPolicyStore());
}

/**
 * Install a policy store — the registry does this for the durable Supabase store; tests use it
 * to inject a fake. Returns the previous store so a caller can restore it. Mirrors
 * setProposalStore / setTrajectoryStore.
 */
export function setApprovalPolicyStore(store: ApprovalPolicyStore): ApprovalPolicyStore {
  const previous = getApprovalPolicyStore();
  setSingleton(STORE_KEY, store);
  return previous;
}

/** Reset to the in-memory default (testing / resetProviders). */
export function resetApprovalPolicyStore(): void {
  setSingleton(STORE_KEY, new InMemoryApprovalPolicyStore());
}
