/**
 * platform/app-framework/types.ts — Application framework type vocabulary
 *
 * Foundational types for the application framework runtime (ADR-028). Domain-agnostic:
 * games, lessons, music exercises, and SaaS workflows all run on ActivitySession.
 * Specific domains (GameDefinition, LessonDefinition, ...) instantiate the generic
 * ActivityDefinition in their own modules.
 *
 * GenAI Principles:
 *   P2  — Agentic execution: the action pipeline is bounded, tiered, instrumented
 *   P4  — Structural safety: effects-as-capability + risk floors, trust nothing declared
 *   P12 — Economic transparency: cost in every result; most-restrictive budget
 *   P15 — Agent identity: ActionContext carries actor + delegation lineage
 *   P17 — Cognition-commitment: propose (cognition) vs commit (commitment) boundary
 *   P18 — Durable trajectories: operationId spine, checkpointable session history
 *
 * @module platform/app-framework
 */

import type {
  AgentIdentity,
  BudgetConfig,
  EffectType,
  RiskLevel,
  StepBoundary,
  Trajectory,
} from "@/platform/agents/types";

/**
 * Re-exported, not re-declared (ADR-029 D1). These are the ADR-028 vocabulary; they moved
 * to platform/agents so `Tool` can carry `effects` without closing an import cycle. Every
 * existing importer of these three from this module is unchanged.
 */
export type { ActionContext, EffectType, RiskLevel } from "@/platform/agents/types";

// ── Capabilities (ADR-028 D6) ─────────────────────────────────────────

/**
 * Orthogonal, composable session capabilities. A session declares which it uses;
 * each attaches its own machinery. Not a closed mode enum.
 */
export type Capability = "turn-based" | "real-time" | "persistent" | "multi-agent";

// ── Effects & Risk (ADR-028 D3) ───────────────────────────────────────

/** Framework-owned minimum risk floor per effect type (D3 seed set; grow per consumer). */
export const EFFECT_RISK_FLOOR: Readonly<Record<EffectType, RiskLevel>> = {
  stateWrite: "ordinary",
  externalCall: "consequential",
  sendMessage: "consequential",
  restricted: "restricted",
};

/** Risk at or above this threshold requires two-phase propose→commit (D3). */
export const GATING_THRESHOLD: RiskLevel = "restricted";

// ── Action durability tiers (ADR-028 D3) ──────────────────────────────

/**
 * - ephemeral: outside the durable protocol; no context, no audit; a restricted
 *   capability environment that structurally cannot touch versioned state.
 * - durable: full ActionContext, idempotent, audited, single-phase commit.
 * - two-phase: durable + requires pre-commit validation/approval (effectiveRisk >= gating).
 */
export type DurabilityTier = "ephemeral" | "durable" | "two-phase";

// ── Action Context (ADR-028 D3) ───────────────────────────────────────

// ActionContext is declared in platform/agents/types.ts and re-exported above. It is
// assembled by the coordinator (SessionService), never by a consumer: the consumer supplies
// intent + actor + payload; the framework fills lineage, operationId, session binding,
// boundary and effectiveRisk. One pipeline for all actor types.

// ── Session State (ADR-028 D2, D5) ────────────────────────────────────

/**
 * Versioned application state. `version` is monotonic; a commit against a stale
 * version is rejected (optimistic concurrency, D5). `TState` is domain-defined and
 * persisted opaquely by the state store.
 */
export interface VersionedState<TState> {
  readonly sessionId: string;
  readonly state: TState;
  readonly version: number;
  /** Action that produced this version — the reconstructible-state guarantee (D2). */
  readonly producedBy?: string;
}

/** Result of a conditional commit (D5). Either it wins, or it returns fresh state. */
export type CommitResult<TState> =
  | { readonly ok: true; readonly version: number; readonly state: TState }
  | {
      readonly ok: false;
      readonly currentVersion: number;
      readonly currentState: TState;
    };

// ── Actions (ADR-028 D1, D3) ──────────────────────────────────────────

/**
 * A domain action a consumer dispatches. `type` selects the definition's handler;
 * `payload` is domain-defined. The framework wraps this in an ActionContext.
 */
export interface Action<TAction> {
  readonly type: string;
  readonly payload: TAction;
}

/**
 * Whether an action commutes (order-independent) — enables reduce-commit for
 * contended keys without a version conflict (D5). Declared per action type.
 */
export interface ActionSpec {
  readonly type: string;
  readonly effects: readonly EffectType[];
  /** Optional consumer-declared risk (advisory, upward-only from the effect floor). */
  readonly declaredRisk?: RiskLevel;
  /** Ephemeral actions are outside the durable protocol (D3). */
  readonly ephemeral?: boolean;
  /** Commutative reducer for hotspot keys — applied against latest, no conflict (D5). */
  readonly commutative?: boolean;
}

// ── Activity Definition (ADR-028 D1, D9) ──────────────────────────────

/**
 * A domain, defined as DATA + pure-function HOOKS (not a class). Generic over the
 * domain's state/action/config types, so GameDefinition = ActivityDefinition<
 * GameState, GameMove, GameConfig> is type-checked. Hooks are PURE (D9) — side
 * effects route through declared effects (D3), never arbitrary I/O inside a hook.
 * Contract is additive-only until a schemaVersion trigger fires (D9).
 */
export interface ActivityDefinition<TState, TAction, TConfig> {
  /** Unique definition id (e.g. "chess", "vocab-lesson"). */
  readonly id: string;
  /** Capabilities sessions of this activity use (D6). */
  readonly capabilities: readonly Capability[];
  /** Action specs — effects, risk, ephemerality, commutativity per action type. */
  readonly actions: readonly ActionSpec[];
  /** Pure: produce the initial state from config. */
  readonly initialState: (config: TConfig) => TState;
  /** Pure policy: is this action valid against this state? (mechanism/policy line, D1). */
  readonly validateAction: (state: TState, action: Action<TAction>) => boolean;
  /** Pure: produce the next state. Must not perform side effects (D9). */
  readonly applyAction: (state: TState, action: Action<TAction>) => TState;
  /** Pure: is the activity complete, and with what outcome? */
  readonly onComplete?: (state: TState) => ActivityOutcome | null;
}

/** Terminal result of an activity. */
export interface ActivityOutcome {
  readonly status: "completed" | "abandoned" | "failed";
  readonly detail?: Record<string, unknown>;
}

// ── Session (ADR-028 D1, D6, D10) ─────────────────────────────────────

/** Lifecycle states of an ActivitySession. */
export type SessionStatus = "created" | "active" | "paused" | "completed";

/**
 * The primary runtime object. Generic over the domain's state/action. Owns lifecycle,
 * versioned state, participants, trajectory, and events. Turn state is present only
 * for turn-based sessions (D6).
 */
export interface ActivitySession<TState, TAction> {
  readonly sessionId: string;
  /** The activity definition this session runs. */
  readonly definitionId: string;
  readonly status: SessionStatus;
  readonly capabilities: readonly Capability[];
  readonly participants: readonly AgentIdentity[];
  /** Current versioned state (D2). */
  readonly current: VersionedState<TState>;
  /** Durable execution history — reused from platform/agents (D4, P18). */
  readonly trajectory: Trajectory;
  /** Optional budget ceiling; absent = unbounded. Enforced only on cost-incurring actions (D10). */
  readonly budget?: BudgetConfig;
  /** Present only when "turn-based" capability is declared (D6). */
  readonly turn?: TurnState;
  /** Phantom marker to bind TAction; not serialized. */
  readonly _action?: TAction;
}

// ── Turn-based core (ADR-028 D6) ──────────────────────────────────────

/**
 * Universal turn-based core. Variant machinery (timing, simultaneity, cross-capability
 * ordering) is NOT here — declaring it throws at registration (D6 extension guard).
 */
export interface TurnState {
  /** Ordered participant ids. */
  readonly order: readonly string[];
  /** Index into `order` whose turn it is. */
  readonly currentIndex: number;
  /** Monotonic turn counter. */
  readonly turnNumber: number;
}

// ── Session Events (ADR-028 D8) ───────────────────────────────────────

/**
 * Framework-native event emitted on session activity. Consumers (trajectory writer,
 * audit, optional realtime bridge) subscribe. Carries agentic-native fields NATIVELY
 * so the realtime subscriber re-envelopes rather than translates (no adapter drift).
 */
export interface SessionEvent {
  readonly type: "state-change" | "trajectory-step" | "approval-request";
  readonly sessionId: string;
  /** Action identity spine (D3). */
  readonly operationId: string;
  /** Trajectory linkage (D4). */
  readonly trajectoryId: string;
  readonly stepIndex?: number;
  /**
   * The justification record, carried from the ActionContext (ADR-031 D9). Optional for
   * the same additive reason as the Step fields; the coordinator always populates them.
   */
  readonly proposalId?: string;
  readonly actor?: AgentIdentity;
  readonly boundary?: StepBoundary;
  readonly effects?: readonly EffectType[];
  readonly effectiveRisk?: RiskLevel;
  /** Optional intent/memory hints, native to the event (D8). */
  readonly intent?: string;
  readonly memoryHint?: string;
  readonly at: string;
}

/** A subscriber to the session event stream (D8). */
export type SessionEventSubscriber = (event: SessionEvent) => void;

// ── AUX-shaped return (ADR-028 D7) ────────────────────────────────────

/**
 * Every session mutation returns this shape so ADR-030 (AUX) wraps rather than
 * rebuilds. `nextActions` is a synchronous filter over the declared action schema
 * (no LLM call); computed eagerly unless opted out for high-frequency paths (D7).
 */
export interface ActionResult<TState> {
  readonly result: VersionedState<TState>;
  readonly trajectory: Trajectory;
  /** Affordances: action types valid from the resulting state. */
  readonly nextActions: readonly string[];
  /** Cost attributed to this action in USD (P12). */
  readonly cost: number;
}

/** Options for dispatching an action (D7 opt-out). */
export interface DispatchOptions {
  /** Skip nextActions enumeration on hot paths (default: compute). */
  readonly computeNextActions?: boolean;
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// (L17) Module-level gotchas — add as discovered.
//
// 1. All fields are `readonly` — spread to modify, never assert away readonly.
//    Mirrors platform/agents/types.ts Gotcha 1.
//
// 2. ActionContext is assembled by the coordinator (SessionService), never by the
//    consumer. Consumers supply Action<TAction> + actor; the framework mints
//    operationId and computes effectiveRisk. Do NOT construct ActionContext in
//    consumer code (D3).
//
// 3. effectiveRisk = max(declaredRisk, max(EFFECT_RISK_FLOOR[e] for e in effects)).
//    RiskLevel order: ordinary < consequential < restricted. Compare via an index
//    map, not string comparison.
//
// 4. ActivityDefinition hooks MUST be pure (D9). Side effects go through declared
//    effects (D3), not I/O inside a hook — replay (D4) and audit depend on it.
//
// 5. TurnState is the universal core only. A definition that needs turn timing /
//    simultaneity must not be silently accepted — the registration guard throws
//    (D6). Do not add variant fields here without a consumer + ADR update.
//
// 6. VersionedState.version is monotonic. A commit passes expectedVersion; a stale
//    version is rejected with fresh state (D5) — never mutate version out of band.
