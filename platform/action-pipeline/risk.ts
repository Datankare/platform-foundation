/**
 * platform/action-pipeline/risk.ts — Risk, tier and context (ADR-028 D3)
 *
 * Pure functions that turn a declared ActionSpec + an actor into a classified,
 * risk-scored ActionContext. No I/O — the SessionService coordinator uses these to
 * decide tier, gating, and audit before touching the state store.
 *
 * The core anti-gaming rule (P4): the framework does not trust a consumer's declared
 * risk. Effects source a framework-owned floor; effectiveRisk = max(declared, floors).
 * A consumer may raise risk, never lower it below the floor.
 *
 * @module platform/action-pipeline
 */

import type { AgentIdentity, StepBoundary } from "@/platform/kernel";
import {
  EFFECT_RISK_FLOOR,
  GATING_THRESHOLD,
  type ActionContext,
  type ActionSpec,
  type DurabilityTier,
  type EffectType,
  type RiskLevel,
} from "@/platform/kernel";

// ── Risk ordering ─────────────────────────────────────────────────────

const RISK_ORDER: Readonly<Record<RiskLevel, number>> = {
  ordinary: 0,
  consequential: 1,
  restricted: 2,
};

/** Compare two risk levels; returns the more severe. */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** Is `a` at or above `b` in severity? */
export function riskAtLeast(a: RiskLevel, b: RiskLevel): boolean {
  return RISK_ORDER[a] >= RISK_ORDER[b];
}

// ── Effective risk (D3 anti-gaming core) ──────────────────────────────

/** The framework-owned floor for a set of effects: max of each effect's floor. */
export function effectFloor(effects: readonly EffectType[]): RiskLevel {
  return effects.reduce<RiskLevel>(
    (acc, e) => maxRisk(acc, EFFECT_RISK_FLOOR[e]),
    "ordinary"
  );
}

/**
 * effectiveRisk = max(declaredRisk, effectFloor(effects)). Declared risk is
 * advisory-upward-only; it can raise the floor, never lower it (P4).
 */
export function computeEffectiveRisk(spec: ActionSpec): RiskLevel {
  const declared = spec.declaredRisk ?? "ordinary";
  return maxRisk(declared, effectFloor(spec.effects));
}

// ── Durability tier (D3) ──────────────────────────────────────────────

/**
 * Classify an action into its durability tier:
 *   - ephemeral: declared ephemeral AND performs no stateWrite (a declared-ephemeral
 *     action that writes state is a contradiction — resolved in favor of durability,
 *     since the stateWrite effect is the load-bearing invariant, D3).
 *   - two-phase: effectiveRisk >= gating threshold.
 *   - durable: everything else.
 */
export function resolveTier(spec: ActionSpec): DurabilityTier {
  const writesState = spec.effects.includes("stateWrite");
  if (spec.ephemeral && !writesState) return "ephemeral";
  const effective = computeEffectiveRisk(spec);
  if (riskAtLeast(effective, GATING_THRESHOLD)) return "two-phase";
  return "durable";
}

/** Does this action require two-phase propose→commit? */
export function requiresTwoPhase(spec: ActionSpec): boolean {
  return resolveTier(spec) === "two-phase";
}

// ── ActionContext assembly (D3 — coordinator-owned) ───────────────────

export interface AssembleContextArgs {
  readonly spec: ActionSpec;
  readonly actor: AgentIdentity;
  readonly sessionId: string;
  /** Minted by the coordinator at intent — never by the consumer. */
  readonly operationId: string;
  /** cognition (proposed/held) or commitment (durable). */
  readonly boundary: StepBoundary;
  /** Present only for revisable gated actions. */
  readonly proposalId?: string;
}

/**
 * Assemble the ActionContext. Called ONLY by the coordinator: it supplies the minted
 * operationId and boundary; the consumer never constructs this. effectiveRisk is
 * computed here so no caller can smuggle a lower risk.
 */
export function assembleActionContext(args: AssembleContextArgs): ActionContext {
  const effectiveRisk = computeEffectiveRisk(args.spec);
  return {
    operationId: args.operationId,
    proposalId: args.proposalId,
    actor: args.actor,
    sessionId: args.sessionId,
    boundary: args.boundary,
    effects: args.spec.effects,
    effectiveRisk,
  };
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// 1. Never compare RiskLevel by string — use RISK_ORDER via maxRisk/riskAtLeast.
//    "consequential" > "ordinary" is false as a string comparison.
//
// 2. computeEffectiveRisk is the single chokepoint for the anti-gaming invariant.
//    Do NOT let any caller pass a precomputed risk that bypasses effectFloor().
//
// 3. resolveTier resolves the ephemeral-but-writes-state contradiction toward durable.
//    The stateWrite effect wins over the ephemeral flag — durability is structural (D3).
