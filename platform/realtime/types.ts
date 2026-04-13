/**
 * platform/realtime/types.ts — Realtime type system
 *
 * Defines the RealtimeProvider interface and agentic-native message schema.
 * Provider implementations (Supabase, Ably, Pusher, etc.) implement this interface.
 * The message schema carries agent identity, intent, trajectory, and memory hints
 * from day one — these are not Phase 5 deferrals.
 *
 * GenAI Principles:
 *   P7  — Provider-aware orchestration (RealtimeProvider interface)
 *   P15 — Agent identity in every message (actorType, actorId, onBehalfOf)
 *   P16 — Cognitive memory hints (memoryHint field)
 *   P17 — Cognition-commitment boundary (intent field)
 *   P18 — Durable execution trajectories (trajectoryId, stepIndex)
 *
 * Latency SLAs:
 *   - Time-to-first-token (AI stream): <2 seconds
 *   - Message broadcast: <200ms local, <500ms global
 *   - Presence propagation: <1 second
 *   - Connection establishment: <3 seconds
 *   - Reconnection after drop: <5 seconds
 *
 * @module platform/realtime
 */

// ---------------------------------------------------------------------------
// Message Schema (agentic-native)
// ---------------------------------------------------------------------------

/** Message types supported by the realtime layer */
export type MessageType =
  | "stream-chunk" // AI response fragment
  | "stream-end" // AI response complete
  | "stream-error" // AI response failed
  | "notification" // System notification
  | "presence-join" // Actor joined channel
  | "presence-leave" // Actor left channel
  | "state-change" // Persistent state mutation
  | "trajectory-step" // Agent execution step
  | "trajectory-end" // Agent execution complete
  | "approval-request" // Agent requesting human approval
  | "approval-response"; // Human response to approval request

/** P15: Actor types for agent identity */
export type ActorType = "user" | "agent" | "system";

/** P17: Intent types for cognition-commitment boundary */
export type MessageIntent =
  | "inform" // Informational, no side effects
  | "propose" // Agent suggesting an action (held until approved)
  | "commit" // Action confirmed and executed
  | "checkpoint" // Agent saving intermediate state
  | "rollback"; // Undoing a committed action

/** P16: Memory type hints for cognitive memory architecture */
export type MemoryHint =
  | "working" // Discard after session
  | "episodic" // Store in trajectory history
  | "semantic" // Candidate for long-term knowledge
  | "procedural" // Candidate for learned routine
  | "resource"; // Reference to an external asset

/**
 * Core message — every message in the realtime layer conforms to this schema.
 * Agentic fields are optional but typed — they activate naturally in Phase 5.
 */
export interface RealtimeMessage {
  /** Unique message ID */
  id: string;
  /** Message classification */
  type: MessageType;
  /** Channel this message belongs to */
  channel: string;
  /** Unix timestamp (ms) */
  timestamp: number;

  // P15: Agent Identity — who sent this
  /** Actor type: user, agent, or system */
  actorType: ActorType;
  /** Actor identifier */
  actorId: string;
  /** Delegation chain — whose behalf the actor is operating on */
  onBehalfOf?: string;

  // P17: Cognition-Commitment Boundary
  /** Message intent — separates deliberation from commitment */
  intent: MessageIntent;

  // P18: Durable Execution Trajectories
  /** Trajectory this message belongs to */
  trajectoryId?: string;
  /** Step index within the trajectory */
  stepIndex?: number;
  /** Parent step for branching trajectories */
  parentStepId?: string;

  // P16: Cognitive Memory hint
  /** Hint for downstream memory systems */
  memoryHint?: MemoryHint;

  /** Message payload — type depends on MessageType */
  payload: unknown;
}

// ---------------------------------------------------------------------------
// AI Streaming
// ---------------------------------------------------------------------------

/** A single chunk from an AI streaming response */
export interface StreamChunk {
  /** Text fragment */
  text: string;
  /** Whether this is the final chunk */
  done: boolean;
  /** Token usage (only present on final chunk) */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cost?: number;
  };
}

/** Options for AI streaming */
export interface StreamOptions {
  /** Model tier override */
  model?: string;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Temperature (0–1) */
  temperature?: number;
  /** Callback for each chunk (client-side) */
  onChunk?: (chunk: StreamChunk) => void;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** Options for creating a channel */
export interface ChannelOptions {
  /** Require authentication to subscribe */
  auth?: boolean;
  /** Maximum number of subscribers */
  maxSubscribers?: number;
  /** Number of historical messages to replay on join */
  historyLength?: number;
  /** Restrict which actor types can subscribe */
  allowedActorTypes?: ActorType[];
}

/** A realtime channel — supports messaging, presence, and streaming */
export interface RealtimeChannel {
  /** Channel name */
  readonly name: string;
  /** Subscribe to messages on this channel */
  subscribe(handler: MessageHandler): Subscription;
  /** Broadcast a message to all subscribers */
  broadcast(message: Omit<RealtimeMessage, "id" | "timestamp">): Promise<void>;
  /** Get current presence entries */
  getPresence(): Promise<PresenceEntry[]>;
  /** Track this actor's presence in the channel */
  trackPresence(state: Record<string, unknown>): Promise<void>;
  /** Stop tracking presence */
  untrackPresence(): Promise<void>;
  /** Unsubscribe from this channel */
  unsubscribe(): void;
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/** A presence entry — who is in a channel */
export interface PresenceEntry {
  /** Actor type */
  actorType: ActorType;
  /** Actor identifier */
  actorId: string;
  /** Custom state */
  state: Record<string, unknown>;
  /** When the actor joined (Unix ms) */
  joinedAt: number;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** Connection state */
export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

// ---------------------------------------------------------------------------
// Stream Writer
// ---------------------------------------------------------------------------

/** Server-side stream writer — used by orchestrator to push chunks */
export interface StreamWriter {
  /** Write a chunk to the stream */
  write(chunk: StreamChunk): Promise<void>;
  /** Close the stream normally */
  close(): Promise<void>;
  /** Abort the stream with an error */
  abort(reason?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Handler types
// ---------------------------------------------------------------------------

/** Message handler callback */
export type MessageHandler = (message: RealtimeMessage) => void;

/** Connection state change handler */
export type ConnectionStateHandler = (state: ConnectionState) => void;

/** Subscription — returned by subscribe methods */
export interface Subscription {
  /** Unsubscribe from the channel/event */
  unsubscribe(): void;
}

// ---------------------------------------------------------------------------
// RealtimeProvider Interface
// ---------------------------------------------------------------------------

/**
 * RealtimeProvider — provider abstraction for realtime communication.
 *
 * Same pattern as AuthProvider, CacheProvider, AIProvider, ErrorReporter.
 * Start with Supabase Realtime. Swap to Ably/Pusher when scale demands it.
 *
 * To add a new provider:
 *   1. Create platform/realtime/{provider}-realtime.ts implementing this interface
 *   2. Map RealtimeMessage schema to provider's native format (preserve all P15-P18 fields)
 *   3. Register in platform/providers/registry.ts
 *   4. Set REALTIME_PROVIDER={provider} env var
 *   5. Add tests in __tests__/{provider}-realtime.test.ts
 *   6. Update ADR-018 providers table
 *
 * See Sprint 5 plan §4 "How to Plug In a New Provider" for detailed guide.
 */
export interface RealtimeProvider {
  /** Provider name for logging */
  readonly name: string;

  // ── Connection lifecycle ──

  /** Establish connection to the realtime service */
  connect(): Promise<void>;
  /** Disconnect from the realtime service */
  disconnect(): Promise<void>;
  /** Get current connection state */
  getConnectionState(): ConnectionState;
  /** Listen for connection state changes. Returns unsubscribe function. */
  onConnectionStateChange(handler: ConnectionStateHandler): () => void;

  // ── Channels ──

  /** Create or get a channel */
  channel(name: string, options?: ChannelOptions): RealtimeChannel;
  /** Remove a channel and clean up subscriptions */
  removeChannel(name: string): Promise<void>;

  // ── AI Streaming (convenience — built on channels internally) ──

  /** Create a server-side stream writer for an AI session */
  createStream(sessionId: string): StreamWriter;
  /** Subscribe to an AI stream on the client side */
  subscribeStream(sessionId: string, handler: (chunk: StreamChunk) => void): Subscription;

  // ── Health ──

  /** Measure current latency to the realtime service (ms) */
  getLatency(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique message ID */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Create a RealtimeMessage with defaults */
export function createMessage(
  partial: Omit<RealtimeMessage, "id" | "timestamp"> &
    Partial<Pick<RealtimeMessage, "id" | "timestamp">>
): RealtimeMessage {
  return {
    id: partial.id ?? generateMessageId(),
    timestamp: partial.timestamp ?? Date.now(),
    ...partial,
  };
}

/** Type guard: is this a streaming message type? */
export function isStreamMessage(msg: RealtimeMessage): msg is RealtimeMessage & {
  type: "stream-chunk" | "stream-end" | "stream-error";
} {
  return (
    msg.type === "stream-chunk" ||
    msg.type === "stream-end" ||
    msg.type === "stream-error"
  );
}

/** Type guard: is this a trajectory message type? */
export function isTrajectoryMessage(msg: RealtimeMessage): msg is RealtimeMessage & {
  type: "trajectory-step" | "trajectory-end";
  trajectoryId: string;
} {
  return (
    (msg.type === "trajectory-step" || msg.type === "trajectory-end") &&
    typeof msg.trajectoryId === "string"
  );
}

/** Type guard: is this an approval message type? */
export function isApprovalMessage(msg: RealtimeMessage): msg is RealtimeMessage & {
  type: "approval-request" | "approval-response";
} {
  return msg.type === "approval-request" || msg.type === "approval-response";
}
