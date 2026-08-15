/**
 * platform/kernel/types.ts — Platform vocabulary
 *
 * The dependency-free foundation every other platform module sits above. This module
 * imports NOTHING from the platform; everything else may import it.
 *
 * It exists because the action pipeline (ADR-029 D2) is shared machinery: both the session
 * adapter (app-framework) and the tool adapter (agents) execute through it, so it cannot
 * live inside either without closing an import cycle. A shared pipeline needs a shared
 * vocabulary beneath it.
 *
 * Layering:
 *
 *   consumers (moderation, admin, input, social, Playform)
 *        │
 *   adapters — app-framework/session.ts · agents/runtime.ts
 *        │
 *   action-pipeline
 *        │
 *   kernel  ← you are here; imports nothing
 *
 * Contents came from platform/agents/types.ts (agent + trajectory + tool vocabulary,
 * ADR-022/029) and platform/app-framework/types.ts (activity + state + event vocabulary,
 * ADR-028). Both original modules now re-export from here, so every existing importer is
 * unchanged — the importer inventory found 48 import statements and zero that needed
 * rewriting.
 *
 * DO NOT add an import to this file. If something here needs a platform type, that type
 * belongs here too, or the thing needing it does not belong in the kernel.
 *
 * @module platform/kernel
 */

// ═══════════════════════════════════════════════════════════════════
// Agent, trajectory and tool vocabulary (was platform/agents/types.ts)
// ADR-022 agent runtime · ADR-029 tool contract
// ═══════════════════════════════════════════════════════════════════
// ── Agent Identity (P15) ──────────────────────────────────────────────

/**
 * Who is performing an action.
 *
 * Every agent action carries identity — the delegation chain from user
 * through planner to executor is fully reconstructible.
 */
export interface AgentIdentity {
  /** What kind of actor: user, agent, or system */
  readonly actorType: "user" | "agent" | "system";
  /** Unique identifier for this actor */
  readonly actorId: string;
  /** Role this agent is playing (e.g., "conductor", "guardian", "classifier") */
  readonly agentRole: string;
  /** If this agent is acting on behalf of someone, their ID */
  readonly onBehalfOf?: string;
}

// ── Trajectory (P18) ──────────────────────────────────────────────────

/**
 * Status of a trajectory.
 *
 * - running: actively executing steps
 * - completed: all steps finished successfully
 * - failed: a step failed and the trajectory was not recovered
 * - paused: checkpointed and waiting for resume or human approval
 */
export type TrajectoryStatus =
  | "running"
  | "completed"
  | "failed"
  | "paused"
  // ADR-029 D10: an external effect neither confirmed nor denied. A workflow
  // containing one is itself indeterminate and MUST NOT report completed.
  | "indeterminate";

/**
 * A durable execution trajectory.
 *
 * The trajectory is the primary runtime object — not the request.
 * It connects a goal to an outcome through a series of inspectable steps.
 * Trajectories survive crashes, support resume, and enable behavioral forensics.
 */
export interface Trajectory {
  /** Unique trajectory ID — stable across all steps in a workflow */
  readonly trajectoryId: string;
  /** The agent that owns this trajectory */
  readonly agentId: string;
  /** Ordered list of steps taken */
  readonly steps: readonly Step[];
  /** Current status */
  readonly status: TrajectoryStatus;
  /** Total accumulated cost in USD across all steps */
  readonly totalCost: number;
  /** ISO timestamp when trajectory was created */
  readonly createdAt: string;
  /** ISO timestamp of last update */
  readonly updatedAt: string;
}

// ── Step (P18) ────────────────────────────────────────────────────────

/**
 * Whether a step is cognition (internal, revisable) or commitment
 * (external, durable, audited). See P17.
 */
export type StepBoundary = "cognition" | "commitment";

// ── Effects & Risk (ADR-028 D3 vocabulary, declared here per ADR-029 D1) ──

/**
 * The unit of both capability grant and risk floor. An action or a tool declares the
 * effects it performs; effects grant the ability to act AND source the minimum risk
 * level. Declaring an effect cannot be gamed (P4).
 *
 * Declared in platform/agents rather than platform/app-framework because ADR-029 D1 puts
 * `effects` on `Tool`, and the dependency runs one way: platform/agents imports nothing,
 * while app-framework, admin, input and moderation all import from it. Declaring these in
 * app-framework and importing them here would close a cycle; re-declaring them here would
 * be the parallel vocabulary ADR-029 D1 rules out. platform/app-framework/types.ts
 * re-exports both, so every existing consumer is unchanged and there is one declaration.
 */
export type EffectType = "stateWrite" | "externalCall" | "sendMessage" | "restricted";

/**
 * Risk level of an action or tool call. `effectiveRisk = max(declaredRisk,
 * max(effectFloors))` — a consumer may raise risk, never lower it below the effect
 * floor (P4). The floors themselves stay in app-framework: they are policy, not
 * vocabulary.
 */
export type RiskLevel = "ordinary" | "consequential" | "restricted";

// ── Action Context (ADR-028 D3, ADR-031 D9) ───────────────────────────

/**
 * The justification record for an action, assembled by the coordinator — never by a
 * consumer and never by a domain hook. Carried across propose → commit → effect →
 * trajectory (ADR-031 D9).
 *
 * Declared here so `Tool.execute` can receive one without platform/agents importing the
 * app-framework. Re-exported from platform/app-framework/types.ts, which remains its
 * conceptual home.
 */
export interface ActionContext {
  /** Stable identity of the logical action across all five stages (ADR-031 D1). */
  readonly operationId: string;
  /** Scoped under operationId; present only for revisable gated actions (ADR-031 D3). */
  readonly proposalId?: string;
  /** Who is acting (P15). */
  readonly actor: AgentIdentity;
  /** The session this action belongs to. */
  readonly sessionId: string;
  /** Cognition (held) vs commitment (durable) — P17. */
  readonly boundary: StepBoundary;
  /** Effects this action performs — capability grant + risk-floor source. */
  readonly effects: readonly EffectType[];
  /** max(declaredRisk, max(effect floors)) — computed by the coordinator. */
  readonly effectiveRisk: RiskLevel;
}

/**
 * A single step within a trajectory.
 *
 * Steps are the atomic unit of agent execution. Each step records
 * what action was taken, what data went in and came out, how long
 * it took, and how much it cost. Steps are typed as cognition or
 * commitment per P17.
 */
export interface Step {
  /** Position in the trajectory (0-indexed) */
  readonly stepIndex: number;
  /** What the agent did (e.g., "classify-audio", "resolve-intent", "route-to-pipeline") */
  readonly action: string;
  /** Input data for this step (serializable) */
  readonly input: Record<string, unknown>;
  /** Output data from this step (serializable) */
  readonly output: Record<string, unknown>;
  /** Cost in USD for this step (0 for rule-based operations) */
  readonly cost: number;
  /** Duration of this step in milliseconds */
  readonly durationMs: number;
  /** ISO timestamp when this step executed */
  readonly timestamp: string;
  /** Whether this step is cognition (revisable) or commitment (durable) — P17 */
  readonly boundary: StepBoundary;
  /**
   * Stable identity of the logical action this step belongs to (ADR-031 D1).
   *
   * The identity fields below are optional so Phase 4 callers compile unchanged
   * (ADR-029 D4 — additive). The framework always populates them.
   */
  readonly operationId?: string;
  /** Present only for revisable gated actions (ADR-031 D3). */
  readonly proposalId?: string;
  /** Who performed this step (P15) — carried from the ActionContext. */
  readonly actor?: AgentIdentity;
  /** Effects this step performed — capability grant + risk-floor source. */
  readonly effects?: readonly EffectType[];
  /** max(declaredRisk, max(effect floors)) as computed for this step. */
  readonly effectiveRisk?: RiskLevel;
  /**
   * The operationId this step compensates (ADR-029 D6).
   *
   * Present only on compensating steps. The original step is never modified or removed —
   * both remain, so the trajectory says what happened AND what was done about it. A history
   * rewritten to claim the first thing never happened cannot be audited.
   */
  readonly compensates?: string;
}

// ── Tool (P5) ─────────────────────────────────────────────────────────

/**
 * The handler a tool runs (ADR-029 D1).
 *
 * `input` is validated against `inputSchema` before the call and the return value against
 * `outputSchema` after (ADR-029 D3) — invalid output is retried within the step budget,
 * never coerced.
 *
 * `context` is optional in Sprint 2 step 1 and becomes required when ADR-029 D2 routes tool
 * invocation through the ADR-028 D3 pipeline. Nothing assembles an ActionContext for a tool
 * call before D2, and a call site synthesising one would be minting an operationId outside
 * the coordinator, which ADR-031 D1 forbids.
 */
export type ToolExecute = (
  input: Record<string, unknown>,
  context?: ActionContext
) => Promise<Record<string, unknown>>;

export interface Tool {
  /** Unique tool identifier */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** What the tool does */
  readonly description: string;
  /** JSON Schema for tool input */
  readonly inputSchema: Record<string, unknown>;
  /** JSON Schema for tool output */
  readonly outputSchema: Record<string, unknown>;
  /**
   * The handler (ADR-029 D1). A registered tool is invocable, not merely declared — the
   * registry no longer stores declarations that nothing can call.
   */
  readonly execute: ToolExecute;
  /** What this tool does to the world, in the ADR-028 D3 vocabulary (ADR-029 D1). */
  readonly effects: readonly EffectType[];
  /** Advisory and upward-only from the effect floor, exactly as ActionSpec (ADR-029 D1). */
  readonly declaredRisk?: RiskLevel;
  /**
   * Whether this tool's effects can be compensated (ADR-029 D6). Absent means true.
   *
   * An agent whose tools include a non-compensable one is refused at registration. That is
   * deliberate and early: discovering irreversibility part-way through a rollback is
   * discovering it too late.
   */
  readonly compensable?: boolean;
  /**
   * The handler that undoes this tool's effect, if one exists. Takes the ORIGINAL input and
   * the recorded output, and performs a new action that cancels the first — a refund for a
   * charge, a retraction for a notice.
   *
   * Its absence is not a claim of irreversibility: a caller may supply a compensating plan
   * per trajectory instead. `compensable: false` is the claim.
   */
  readonly compensate?: (
    originalInput: Record<string, unknown>,
    originalOutput: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  /**
   * The external effects this tool fires, each routed through the effect ledger
   * (ADR-031 D7).
   *
   * A LIST, not a single call: a tool that charges a card and sends a receipt has two
   * effects with two idempotency keys, and discovering that after shipping a single-call
   * field would mean a second contract change.
   *
   * Declaring `externalCall` or `sendMessage` in `effects` and leaving this empty is a
   * contract violation the adapter refuses. `effects` already grants capability
   * structurally, so leaving the corresponding obligation voluntary would be inconsistent
   * (P4) — and a ledger nothing writes to cannot prevent a double-fire.
   */
  readonly externalEffects?: readonly ToolExternalEffect[];
}

/**
 * One external effect a tool fires, declared so the platform can wrap it in a ledger entry
 * rather than trusting the tool to do so (ADR-031 D7).
 */
export interface ToolExternalEffect {
  /** Distinguishes this effect from others in the same invocation. */
  readonly key: string;
  readonly type: "externalCall" | "sendMessage";
  /**
   * Performs the downstream call. Receives the tool's input and the idempotency key derived
   * from the operationId — hand that key to downstreams that accept one; the ledger exists
   * for those that do not.
   */
  readonly call: (
    input: Record<string, unknown>,
    idempotencyKey: string
  ) => Promise<Record<string, unknown>>;
  /**
   * Asks the downstream whether a previous attempt landed, for a retry that finds an
   * unresolved ledger entry. Omit when it cannot be asked — the operation then surfaces as
   * indeterminate rather than being guessed at.
   *
   * This stays with the tool because it is per-downstream: asking Stripe whether a charge
   * landed is Stripe-specific, and the platform can carry the question but not answer it.
   */
  readonly reconcile?: (
    idempotencyKey: string
  ) => Promise<Record<string, unknown> | undefined>;
}

// ── Budget (P12) ──────────────────────────────────────────────────────

/**
 * Budget configuration for an agent.
 *
 * Prevents runaway costs by capping per-trajectory and daily spend.
 */
export interface BudgetConfig {
  /** Maximum cost in USD per trajectory */
  readonly maxCostPerTrajectory: number;
  /** Maximum cost in USD per day */
  readonly maxCostPerDay: number;
  /** Maximum number of steps per trajectory */
  readonly maxStepsPerTrajectory: number;
}

/** Sensible defaults — tight budget for rule-based agents */
export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  maxCostPerTrajectory: 0.1,
  maxCostPerDay: 5.0,
  maxStepsPerTrajectory: 20,
};

// ── Effort Tier (P12) ──────────────────────────────────────────────────

/**
 * Effort tier for agent LLM calls.
 *
 * Controls how much thinking budget an agent gets per step.
 * "low" for clear signals, "standard" for typical decisions,
 * "max" for ambiguous or high-stakes evaluations.
 *
 * Informed by Rezvani 2026 "/powerup" analysis: not every
 * classification needs Opus-max tokens.
 */
export type EffortTier = "low" | "standard" | "max";

// ── Agent Config (P2) ─────────────────────────────────────────────────

/**
 * Configuration for an agent instance.
 *
 * Agents are configured, not coded. The runtime reads AgentConfig
 * to know what tools an agent has, what its budget is, and what
 * its identity is.
 */
export interface AgentConfig {
  /** Unique agent identifier */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** Description of what this agent does */
  readonly description: string;
  /** Tools available to this agent */
  readonly tools: readonly Tool[];
  /** Budget constraints */
  readonly budgetConfig: BudgetConfig;
  /** Effort tier for LLM calls (P12) — defaults to "standard" */
  readonly effortTier?: EffortTier;
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// (L17) Module-level gotchas — add issues here as they're discovered.
//
// 1. All fields are `readonly` — use spread operator to create modified copies.
//    Do NOT use type assertions to bypass readonly.
//
// 2. Step.input and Step.output are Record<string, unknown> — always validate
//    structure before accessing nested fields. Use type guards.
//
// 3. Trajectory.steps is `readonly Step[]` — to add a step, spread into a new
//    array: `{ ...trajectory, steps: [...trajectory.steps, newStep] }`
//
// 4. BudgetConfig.maxCostPerTrajectory = 0.10 USD by default. This is intentionally
//    tight for rule-based agents. Override for LLM-backed agents in Sprint 4b.

// ═══════════════════════════════════════════════════════════════════
// Activity, state and event vocabulary (was platform/app-framework/types.ts)
// ADR-028 application framework
// ═══════════════════════════════════════════════════════════════════
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
  /**
   * Whether this action can be compensated (ADR-029 D6). Absent means true.
   *
   * Declaring `false` means the effects cannot be undone by any subsequent action — a
   * physical dispatch, an irrevocable transfer, a message that cannot be recalled. A
   * workflow containing one is refused at registration rather than discovered mid-rollback.
   *
   * Note the direction: rollback does not reverse a committed transition, it APPENDS a
   * compensating one. `compensable: false` says no such compensating action exists.
   */
  readonly compensable?: boolean;
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

// ── Agent response envelope (ADR-030 D5) ──────────────────────────────

/**
 * The workflow an agent asks for. Request-level (ADR-030 D1).
 *
 * NOT the provider layer's `intent` (IDENTIFY_INTENT, STEP_INTENT_MAP), which is
 * step-level and annotates what one internal step is doing. Two layers, two names,
 * deliberately: `goal` names what was asked, `intent` names what a step does. Neither
 * name is ever used for the other.
 */
export type AgentGoal =
  | "identify-song"
  | "translate"
  | "transcribe"
  | "speak"
  | "translate-and-speak"
  | "full-pipeline"
  | "analyze";

/** An affordance that ends the workflow rather than naming a further goal (D3). */
export type TerminalAction = "done" | "retry";

/**
 * One thing the agent can do next. `nextActions` is never empty — a finished workflow
 * offers `done` rather than nothing, which is the difference between an agent surface
 * and an RPC (ADR-030 D3).
 */
export interface NextAction {
  readonly action: AgentGoal | TerminalAction;
  /** Human-readable, for debugging and for an agent's own reasoning trace. */
  readonly description: string;
  /** Where to call. Null for a terminal action. */
  readonly endpoint: string | null;
  readonly requiredParams: readonly string[];
  /** Numeric so an agent can sum and compare it against its ceiling (P12). */
  readonly estimatedCostUSD: number;
}

/**
 * Response-level cost attribution (P12, ADR-030 D5).
 *
 * Distinct from TrajectoryCost below, which is the PERSISTED view — `{tokens, apiCalls,
 * usd}` on the trajectory record. This is the returned view, and it carries two fields
 * the persisted one does not (cache attribution). The workflow loop maps between them;
 * neither is derived from the other by renaming.
 */
export interface CostSummary {
  readonly apiCalls: number;
  readonly tokensUsed: number;
  readonly estimatedCostUSD: number;
  readonly cachedResults: number;
  readonly costSavedFromCache: number;
}

/**
 * The fixed envelope every /api/agent/* response carries (ADR-030 D5), enforced at
 * runtime by the L21 kit at __tests__/contract/agent-response-contract.ts.
 *
 * Structurally parallel to ActionResult above, and deliberately NOT the same type. They
 * share `Trajectory` and nothing else: `result` here is the goal's own result rather
 * than versioned session state, `nextActions` enumerates workflow goals rather than
 * activity action types valid from a state, and `cost` is a summary rather than one
 * action's number. Widening ActionResult to serve both would put an always-null
 * `endpoint` and an always-zero `estimatedCostUSD` on every session dispatch, and would
 * break ADR-028 D7's promise that nextActions is a synchronous filter over the declared
 * action schema. See the ADR-030 amendment of 2026-08-15.
 */
export interface AgentResponse<T> {
  readonly result: T;
  readonly trajectory: Trajectory;
  readonly nextActions: readonly NextAction[];
  readonly cost: CostSummary;
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
//
// 7. ActionResult and AgentResponse are NOT interchangeable, despite four fields with
//    the same names. ActionResult.nextActions is string[] of activity action types;
//    AgentResponse.nextActions is NextAction[] of workflow goals. A function taking
//    one will accept neither the other's nextActions nor its cost. Check which layer
//    you are on before reaching for either.
//
// 8. A trajectory identifies itself as `trajectoryId`, never `id`, at every level —
//    on Trajectory, and one level down inside TrajectoryRecord (GOTCHA-78). Do not add
//    an `id` synonym to any agent-facing type: reading the wrong one yields undefined
//    rather than a type error, which is how a correctly written row presented as a
//    broken store in TASK-075a.

// ═══════════════════════════════════════════════════════════════════
// Trajectory persistence contract (was platform/agents/trajectory-store.ts)
// ADR-022 · ADR-029 D4. Implementations and the singleton stay in platform/agents.
// ═══════════════════════════════════════════════════════════════════

/** Whether a trajectory belongs to an agent run or to an application session. */
export type TrajectorySubjectKind = "agent" | "session";

/**
 * Who or what the trajectory is about.
 *
 * Before ADR-029 D4, session trajectories were created by passing a sessionId into the
 * `agentId` parameter. It type-checked and was semantically wrong: session trajectories
 * were indistinguishable from agent trajectories and no query could retrieve them by
 * session.
 */
export interface TrajectorySubject {
  readonly kind: TrajectorySubjectKind;
  readonly id: string;
}

/** Options for querying trajectories */
export interface TrajectoryQuery {
  readonly agentId?: string;
  /** Filter to agent trajectories or session trajectories (ADR-029 D4). */
  readonly subjectKind?: TrajectorySubjectKind;
  /** Filter to one subject id — the sessionId for session trajectories. */
  readonly subjectId?: string;
  readonly scopeType?: "group" | "user" | "platform";
  readonly scopeId?: string;
  readonly status?: TrajectoryStatus;
  readonly limit?: number;
}

/** Cost summary stored alongside trajectory */
export interface TrajectoryCost {
  readonly tokens: number;
  readonly apiCalls: number;
  readonly usd: number;
}

/** Full trajectory record with persistence metadata */
export interface TrajectoryRecord {
  readonly trajectory: Trajectory;
  /** What this trajectory is about — agent run or session (ADR-029 D4). */
  readonly subject: TrajectorySubject;
  readonly trigger: string;
  readonly scopeType: "group" | "user" | "platform";
  readonly scopeId: string | null;
  readonly costSummary: TrajectoryCost;
}

export interface TrajectoryStore {
  /**
   * Create a new trajectory for an explicit subject. Returns the record.
   *
   * The subject is a discriminator, not a renamed agentId (ADR-029 D4): a session
   * trajectory and an agent trajectory are now distinguishable without inspecting the
   * trigger string.
   */
  create(
    subject: TrajectorySubject,
    trigger: string,
    scopeType: "group" | "user" | "platform",
    scopeId?: string
  ): Promise<TrajectoryRecord>;

  /** Add a step to a trajectory. Returns updated record. */
  addStep(trajectoryId: string, step: Step): Promise<TrajectoryRecord | undefined>;

  /** Update trajectory status. */
  updateStatus(
    trajectoryId: string,
    status: TrajectoryStatus
  ): Promise<TrajectoryRecord | undefined>;

  /** Get a trajectory by ID. */
  getById(trajectoryId: string): Promise<TrajectoryRecord | undefined>;

  /** Query trajectories with filters. */
  query(options: TrajectoryQuery): Promise<readonly TrajectoryRecord[]>;
}

// ═══════════════════════════════════════════════════════════════════
// Proposal persistence contract (ADR-031 D2/D3/D8)
// Implementations and the singleton live in platform/agents.
// ═══════════════════════════════════════════════════════════════════

/**
 * Lifecycle of a held action (ADR-031 D2).
 *
 * `rejected` and `superseded` are TERMINAL and produce a trajectory with no stateVersion
 * (D8). They are deliberately distinct from TrajectoryStatus: a trajectory can be paused
 * while its proposal is still `proposed`, and conflating the two would lose that.
 */
export type ProposalStatus = "proposed" | "approved" | "rejected" | "superseded";

/** A held gated action awaiting a decision. */
export interface ProposalRecord {
  readonly proposalId: string;
  /** One operationId may carry many proposals; at most one is live (D3). */
  readonly operationId: string;
  readonly sessionId: string;
  readonly trajectoryId: string;
  /** Action type or tool id. */
  readonly label: string;
  readonly status: ProposalStatus;
  readonly actor: AgentIdentity;
  readonly effects: readonly EffectType[];
  readonly effectiveRisk: RiskLevel;
  readonly payload: Record<string, unknown>;
  /** State version observed at proposal time — the stale-approval anchor (D5). */
  readonly observedVersion?: number;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly decisionNote?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProposalQuery {
  readonly operationId?: string;
  readonly trajectoryId?: string;
  readonly status?: ProposalStatus;
  readonly limit?: number;
}

export interface CreateProposalArgs {
  readonly operationId: string;
  readonly sessionId: string;
  readonly trajectoryId: string;
  readonly label: string;
  readonly actor: AgentIdentity;
  readonly effects: readonly EffectType[];
  readonly effectiveRisk: RiskLevel;
  readonly payload?: Record<string, unknown>;
  readonly observedVersion?: number;
}

/**
 * Durable proposal storage.
 *
 * `decide` MUST be atomic on the proposal's current status: a second approval of the same
 * proposal is a no-op returning the original (ADR-031 D4), and two concurrent decisions
 * must not both win.
 */
export interface ProposalStore {
  create(args: CreateProposalArgs): Promise<ProposalRecord>;
  getById(proposalId: string): Promise<ProposalRecord | undefined>;
  /** Transition a proposal, only from `proposed`. Returns undefined if it already moved. */
  decide(
    proposalId: string,
    status: Exclude<ProposalStatus, "proposed">,
    decidedBy: string,
    note?: string
  ): Promise<ProposalRecord | undefined>;
  query(options: ProposalQuery): Promise<readonly ProposalRecord[]>;
}

// ═══════════════════════════════════════════════════════════════════
// Effect ledger contract (ADR-031 D7, ADR-029 D10)
// Implementations and the singleton live in platform/agents.
// ═══════════════════════════════════════════════════════════════════

/**
 * Outcome of one external effect.
 *
 * `indeterminate` is terminal and real: the downstream neither confirmed nor denied.
 * It MUST NOT be collapsed into confirmed or failed — that is an at-most-once or
 * at-least-once violation depending on the direction of the guess, and the guess is
 * invisible afterwards (ADR-031 D7).
 */
export type EffectStatus = "pending" | "confirmed" | "failed" | "indeterminate";

/** The subset of EffectType that reaches outside the system. */
export type ExternalEffectType = "externalCall" | "sendMessage";

export interface EffectLedgerEntry {
  readonly entryId: string;
  readonly operationId: string;
  /** Distinguishes multiple effects within one operation. */
  readonly effectKey: string;
  readonly effectType: ExternalEffectType;
  readonly status: EffectStatus;
  /** Derived from operationId — handed to downstreams that accept one. */
  readonly idempotencyKey: string;
  readonly request: Record<string, unknown>;
  readonly receipt?: Record<string, unknown>;
  readonly error?: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly resolvedAt?: string;
}

export interface BeginEffectArgs {
  readonly operationId: string;
  readonly effectKey: string;
  readonly effectType: ExternalEffectType;
  readonly request?: Record<string, unknown>;
}

/**
 * Durable record of external effects.
 *
 * `begin` MUST be idempotent on (operationId, effectKey): a retry returns the EXISTING
 * entry rather than creating a second one, which is what makes "does not re-fire"
 * expressible at all.
 */
export interface EffectLedger {
  /** Write before the call. Returns the existing entry on retry, with `attempts` raised. */
  begin(args: BeginEffectArgs): Promise<EffectLedgerEntry>;
  /** Resolve after the call. Only from `pending`; returns undefined if already resolved. */
  resolve(
    operationId: string,
    effectKey: string,
    status: Exclude<EffectStatus, "pending">,
    detail?: { receipt?: Record<string, unknown>; error?: string }
  ): Promise<EffectLedgerEntry | undefined>;
  get(operationId: string, effectKey: string): Promise<EffectLedgerEntry | undefined>;
  /** Everything still pending or indeterminate — the human-resolution queue. */
  listUnresolved(limit?: number): Promise<readonly EffectLedgerEntry[]>;
}

// ═══════════════════════════════════════════════════════════════════
// Session metadata (TASK-071)
// ═══════════════════════════════════════════════════════════════════

/**
 * The part of a session that is not its state.
 *
 * `state` answers what is true; this answers what this session IS. None of it was persisted
 * before, so an ActivitySession could be created and never reconstructed — and ADR-031 D6's
 * repair, which the ADR places "on session load", had no load to run in.
 */
export interface SessionMeta {
  readonly definitionId: string;
  readonly status: SessionStatus;
  readonly capabilities: readonly Capability[];
  readonly participants: readonly AgentIdentity[];
  readonly budget?: BudgetConfig;
  /**
   * Persisted so a turn-based session does not lose whose turn it is on restart.
   * Advancement remains the caller's — see updateSessionMeta and TASK-072.
   */
  readonly turn?: TurnState;
}
