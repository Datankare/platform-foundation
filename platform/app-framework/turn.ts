/**
 * platform/app-framework/turn.ts — Turn-based capability core (ADR-028 D6)
 *
 * Ships the UNIVERSAL core only: turn order, current-turn state, advancement, and
 * turn validation. Variant machinery (timing/deadlines, simultaneous turns, skip/pass,
 * turn-based × multi-agent ordering, turn-based × real-time) is NOT implemented — it
 * ships with a real turn-based consumer.
 *
 * Forget-proofing: a definition that declares an unimplemented variant does NOT silently
 * get wrong behavior — assertTurnConfigSupported() throws at registration with a pointer
 * to this decision. The first consumer that needs a variant hits a named wall.
 *
 * @module platform/app-framework
 */

import type { AgentIdentity } from "@/platform/agents/types";
import type { TurnState } from "./types";

/**
 * Variant knobs a consumer might declare. None are implemented in the Sprint 1 core;
 * declaring any of them throws (D6 extension guard).
 */
export interface TurnVariantConfig {
  /** Per-turn deadline in ms — NOT implemented. */
  readonly turnTimeoutMs?: number;
  /** Allow multiple participants to act in the same turn — NOT implemented. */
  readonly simultaneous?: boolean;
  /** Allow skipping/passing a turn — NOT implemented. */
  readonly allowSkip?: boolean;
  /** Interleave agent actors into the turn queue — NOT implemented. */
  readonly agentTurnPolicy?: string;
}

const UNIMPLEMENTED_VARIANTS: readonly (keyof TurnVariantConfig)[] = [
  "turnTimeoutMs",
  "simultaneous",
  "allowSkip",
  "agentTurnPolicy",
];

/**
 * Registration guard (D6). Throws if a definition declares turn variant machinery the
 * core does not implement — so the need surfaces at registration, not as silent wrong
 * behavior discovered after the fact.
 */
export function assertTurnConfigSupported(config?: TurnVariantConfig): void {
  if (!config) return;
  const declared = UNIMPLEMENTED_VARIANTS.filter((k) => config[k] !== undefined);
  if (declared.length > 0) {
    throw new Error(
      `app-framework: turn variant(s) [${declared.join(", ")}] declared but not implemented — ` +
        `the Sprint 1 turn core covers order, current-turn, advancement, and validation only. ` +
        `See ADR-028 D6 (extension seams) before adding variant machinery.`
    );
  }
}

// ── Universal core ────────────────────────────────────────────────────

/** Initialize turn state from an ordered participant list. */
export function initTurnState(participants: readonly AgentIdentity[]): TurnState {
  return {
    order: participants.map((p) => p.actorId),
    currentIndex: 0,
    turnNumber: 1,
  };
}

/** The actorId whose turn it currently is. */
export function currentTurnActor(turn: TurnState): string | undefined {
  return turn.order[turn.currentIndex];
}

/** Is it this actor's turn? The validation the coordinator enforces before an action. */
export function isCurrentTurn(turn: TurnState, actorId: string): boolean {
  return currentTurnActor(turn) === actorId;
}

/** Advance to the next participant, wrapping and incrementing the turn counter. */
export function advanceTurn(turn: TurnState): TurnState {
  if (turn.order.length === 0) return turn;
  const nextIndex = (turn.currentIndex + 1) % turn.order.length;
  return {
    order: turn.order,
    currentIndex: nextIndex,
    turnNumber: turn.turnNumber + 1,
  };
}

/** Remove a participant from the order, keeping the current actor stable where possible. */
export function removeParticipant(turn: TurnState, actorId: string): TurnState {
  const idx = turn.order.indexOf(actorId);
  if (idx === -1) return turn;
  const order = turn.order.filter((id) => id !== actorId);
  if (order.length === 0) {
    return { order, currentIndex: 0, turnNumber: turn.turnNumber };
  }
  // If the removed actor was before the current one, shift the pointer back to keep
  // the same actor current; if it WAS the current one, the next actor becomes current.
  const currentIndex =
    idx < turn.currentIndex ? turn.currentIndex - 1 : turn.currentIndex % order.length;
  return { order, currentIndex, turnNumber: turn.turnNumber };
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// 1. TurnState is immutable — advanceTurn/removeParticipant return a NEW state.
//
// 2. Do NOT add variant fields (timing, simultaneity) here. They belong behind the
//    extension guard until a real consumer constrains their shape (D6). Adding them
//    speculatively is the exact failure mode D6 avoids.
//
// 3. removeParticipant keeps the current actor stable when someone earlier in the order
//    leaves; when the CURRENT actor is removed, the next actor becomes current without
//    incrementing turnNumber (the turn was never completed).
