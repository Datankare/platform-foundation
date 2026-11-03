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
 * so nothing changes until an admin adds a rule. A3 adds the durable (Postgres) store and
 * the versioned, audited setRules mutation; A2 is the conformance kit every implementation
 * must pass; A4 is the admin route that calls setRules. This file pre-empts none of them.
 *
 * GenAI Principles: P10 (human oversight is the default), P13 (bounded autonomy governed
 * centrally), P17 (a policy change is a commitment), P3/P18 (versioned, reconstructable).
 *
 * @module platform/agents
 */

import { logger } from "@/lib/logger";
import type { AgentIdentity, EffectType, RiskLevel } from "@/platform/kernel";
import { getSingleton, setSingleton } from "@/platform/kernel";
import { TenantPartitionedMap } from "@/platform/tenancy/partition";
import { peekTenant } from "@/platform/tenancy/context";

/** The actor type an approval requires — the three legal AgentIdentity.actorType values. */
export type ActorType = AgentIdentity["actorType"];

/** Risk ordering, lowest → highest. Mirrors the workflow-loop / pipeline computation. */
/** The risk levels a rule may bound, lowest first. */
export const RISK_ORDER: readonly RiskLevel[] = [
  "ordinary",
  "consequential",
  "restricted",
];

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
 * The store contract. A1 provides InMemoryApprovalPolicyStore; A3 provides the Postgres
 * implementation; both must pass A2's conformance kit. `setRules` bumps the version and
 * records who decided — the durable store makes that atomic and audited (A3).
 */
export interface ApprovalPolicyStore {
  /** The current policy. Never null: an unset store returns the default policy. */
  load(): Promise<ApprovalPolicy>;
  /**
   * Replace the rule list, bumping version. `decidedBy` is the deciding actor id (A3 audits).
   * `defaultApprover`, when given, replaces who approves an action no rule matches; absent, the
   * current one is carried forward (TASK-194 round 11: set_approval_policy's `default_approver`
   * was taken and dropped).
   */
  setRules(
    rules: readonly ApprovalRule[],
    decidedBy: string,
    defaultApprover?: ActorType
  ): Promise<ApprovalPolicy>;
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
 * Resolve the required approver for a held action, PURELY, against a given policy. A
 * restricted action — by its risk or its effects — is a person's ("user"), before the policy is
 * read ("restricted ⇒ person", ADR-030/ADR-040 addendum, TASK-194): while GATING_THRESHOLD is
 * "restricted" that is every held action, so the policy decides no current hold. Below
 * restricted, the first rule whose risk bound and effects both match wins; otherwise the
 * policy default. Returns the AgentIdentity shape the gating contract uses — the concrete
 * actorId/role of a human approver stays a consumer concern; what is fixed is the actorType.
 */
export function resolveApprover(
  policy: ApprovalPolicy,
  effectiveRisk: RiskLevel,
  effects: readonly EffectType[]
): AgentIdentity {
  const matched = policy.rules.find(
    (r) => riskAtOrBelow(effectiveRisk, r.maxRisk) && effectsPresent(r.effects, effects)
  );
  // A restricted action is always a person's to approve, whatever the policy says (round 12,
  // I-2): no rule may name another approver for one (approvalRulesProblem), and the default —
  // which an action no rule matches falls to — never decides one either (defence in depth: a
  // policy that reached here past the stores' checks still cannot weaken it).
  const restricted = effectiveRisk === "restricted" || effects.includes("restricted");
  const actorType: ActorType = restricted
    ? "user"
    : matched
      ? matched.requiredApprover
      : policy.default;
  return {
    actorType,
    actorId: actorType === "user" ? "pending-human-approver" : "pending-approver",
    agentRole: "approver",
  };
}

/** The effects a rule may be limited to. */
export const POLICY_EFFECTS: readonly string[] = [
  "stateWrite",
  "externalCall",
  "sendMessage",
  "restricted",
];

/** Who may approve a held action: the actor types a rule may name. */
export const APPROVERS: readonly ActorType[] = ["user", "agent", "system"];

/**
 * Who the policy's default may be: a person ("user") only (round 12, I-2; reason corrected in
 * round 13). The default decides an action no rule matches. A restricted one it never decides —
 * resolveApprover gives every restricted action to a person before it reads the policy — so the
 * default matters only below restricted, which reaches a hold only in an app that lowers
 * GATING_THRESHOLD. There, a person as the default means an action no rule names still waits for
 * one: lowering the threshold never hands unmatched actions to an agent unasked, and an agent
 * approves only the classes a rule names, by risk and effect. A second line of defence too: a
 * policy read past these checks still names no non-person approver for an unmatched action. It
 * is what every stored policy had (no writer stored another default before round 11).
 */
export const POLICY_DEFAULT_APPROVERS: readonly ActorType[] = ["user"];

/** Why `defaultApprover` cannot be a policy's default, or null. */
export function defaultApproverProblem(defaultApprover: unknown): string | null {
  return POLICY_DEFAULT_APPROVERS.includes(defaultApprover as ActorType)
    ? null
    : `the default approver must be one of ${POLICY_DEFAULT_APPROVERS.join(", ")}: an action no rule matches may be restricted, and a restricted action is always approved by a person`;
}

/**
 * Why a policy — its rules, and the default when one is given — cannot be stored, or null. The
 * one check the handler and both stores apply (round 12, I-2).
 */
export function approvalPolicyProblem(
  rules: readonly ApprovalRule[],
  defaultApprover?: unknown
): string | null {
  return (
    approvalRulesProblem(rules) ??
    (defaultApprover === undefined ? null : defaultApproverProblem(defaultApprover))
  );
}

/**
 * Overridden stored versions (per tenant) already warned about: least recently seen first (a Set
 * keeps insertion order), at most OVERRIDES_SAID_MAX.
 */
const OVERRIDES_SAID = new Set<string>();
const OVERRIDES_SAID_MAX = 100;

/**
 * A stored policy as it is applied: a default the stores would refuse to write — one set by hand
 * in the table, since no writer ever stored another — is read as "user" (round 12, I-2: fail
 * safe; stricter, never weaker, than what it says).
 */
export function appliedPolicy(policy: ApprovalPolicy): ApprovalPolicy {
  if (defaultApproverProblem(policy.default) === null) return policy;
  // Said, so an operator who set it by hand finds out (round 13, nit 1) — once per tenant, stored
  // version and value in this process, not on every load (round 14, item 10: every hold and
  // every workflow step loads the policy). Per tenant (round 15, I-7): each tenant's store has
  // its own versions — tenant A's version 3 says nothing of tenant B's. The tenant is only
  // reported here (peekTenant), never read by.
  const tenantId = peekTenant()?.tenantId ?? "-";
  const said = `${tenantId}:${policy.version}:${String(policy.default).slice(0, 40)}`;
  // Least recently seen first (round 16, nit 4): a hit moves to the end, and a full set lets go
  // of its oldest one only — it cleared everything at 100, and every version warned again.
  if (OVERRIDES_SAID.delete(said)) {
    OVERRIDES_SAID.add(said);
    return { ...policy, default: "user" };
  }
  if (OVERRIDES_SAID.size >= OVERRIDES_SAID_MAX)
    OVERRIDES_SAID.delete(OVERRIDES_SAID.values().next().value as string);
  OVERRIDES_SAID.add(said);
  logger.warn(
    "Approval policy default overridden: a stored non-person default is applied as user",
    {
      storedDefault: String(policy.default).slice(0, 40),
      version: policy.version,
      tenantId,
      route: "platform/agents/approval-policy-store",
    }
  );
  return { ...policy, default: "user" };
}

/**
 * Why `rules` cannot be stored, or null. Every store checks this before saving.
 *
 * ADR-030 keeps agent and system approval reachable by policy for classes of action that have
 * earned it — but never for a restricted (dual-control, catastrophic-if-wrong) action, which
 * always needs an independent human (ADR-039, ADR-040). Risk levels, effects and approvers must
 * be ones the gate knows, or a rule would silently never match.
 */
export function approvalRulesProblem(rules: readonly ApprovalRule[]): string | null {
  if (!Array.isArray(rules)) return "rules must be a list";
  if (rules.length > 50) return "at most 50 rules";
  for (const [i, rule] of rules.entries()) {
    if (!rule || typeof rule !== "object") return `rule ${i + 1} is not an object`;
    if (!RISK_ORDER.includes(rule.maxRisk)) {
      return `rule ${i + 1}: maxRisk must be one of ${RISK_ORDER.join(", ")}`;
    }
    if (!APPROVERS.includes(rule.requiredApprover as ActorType)) {
      return `rule ${i + 1}: requiredApprover must be one of ${APPROVERS.join(", ")}`;
    }
    if (
      rule.effects !== undefined &&
      (!Array.isArray(rule.effects) ||
        rule.effects.some((e: string) => !POLICY_EFFECTS.includes(e)))
    ) {
      return `rule ${i + 1}: effects must be from ${POLICY_EFFECTS.join(", ")}`;
    }
    const coversRestricted =
      rule.maxRisk === "restricted" || (rule.effects ?? []).includes("restricted");
    if (coversRestricted && rule.requiredApprover !== "user") {
      return `rule ${i + 1}: a restricted action is always approved by a person ("user")`;
    }
  }
  return null;
}

/**
 * In-memory policy store. The A1 default implementation; PostgresApprovalPolicyStore is the
 * durable one. Each tenant has its own policy, starting at `initial`, as row-level security
 * gives each tenant its own policy history in Postgres (ADR-053 D6).
 */
export class InMemoryApprovalPolicyStore implements ApprovalPolicyStore {
  private readonly parts = new TenantPartitionedMap<"policy", ApprovalPolicy>();

  constructor(private readonly initial: ApprovalPolicy = DEFAULT_APPROVAL_POLICY) {}

  /** Synchronous, so setRules reads and writes with no await between (no lost update). */
  private currentPolicy(): ApprovalPolicy {
    return this.parts.current().get("policy") ?? this.initial;
  }

  async load(): Promise<ApprovalPolicy> {
    return appliedPolicy(this.currentPolicy());
  }

  async setRules(
    rules: readonly ApprovalRule[],
    _decidedBy: string,
    defaultApprover?: ActorType
  ): Promise<ApprovalPolicy> {
    const problem = approvalPolicyProblem(rules, defaultApprover);
    if (problem) throw new Error(`approval-policy setRules refused: ${problem}`);
    const current = appliedPolicy(this.currentPolicy());
    const next: ApprovalPolicy = {
      version: current.version + 1,
      default: defaultApprover ?? current.default,
      rules,
    };
    this.parts.current().set("policy", next);
    return next;
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
 * Install a policy store — the registry does this for the durable Postgres store; tests use it
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
