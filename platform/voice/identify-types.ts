/**
 * platform/voice/identify-types.ts — Song identification contracts
 *
 * Defines the provider interface for audio fingerprint-based song
 * identification (ACRCloud, AudD.io, or future providers).
 *
 * Privacy by design:
 *   - Audio exists in memory only during request lifecycle
 *   - Providers receive ONLY canonical WAV, no user/session/device info
 *   - Audit logs record who/when/result — NEVER audio content
 *   - 10-15s clip maximum sent to provider
 *
 * GenAI Principles:
 *   P1  — All identification through SongIdentificationProvider
 *   P2  — Every call returns latency + confidence for metrics
 *   P3  — Metadata stripped before provider receives audio (via canonical format)
 *   P5  — estimatedCostUsd in every IdentifyResult
 *   P6  — SongMatch structured result type
 *   P7  — Provider abstraction: swap ACRCloud → AudD.io via env var
 *   P9  — requestId for distributed tracing
 *   P10 — MockSongIdentifier for tests
 *   P11 — No match → IdentifyResult with match=null (not an error)
 *   P13 — Rate limiting: SONG_IDENTIFY rule in DEFAULT_RULES
 *   P14 — Audit: who, when, result — never audio content
 *   P15 — actorType/actorId on every request
 *   P16 — IdentifyCache interface for fingerprint dedup
 *   P17 — IDENTIFY_INTENT constant: "inform"
 *   P18 — trajectoryId/stepIndex on request and result
 *
 * @module platform/voice
 */

// ── Intent Mapping (P17) ────────────────────────────────────────────────

/**
 * Song identification intent: "inform" — reporting what was heard.
 * Consistent with VoicePipeline's STEP_INTENT_MAP.
 */
export const IDENTIFY_INTENT = "inform" as const;

// ── Song Match ──────────────────────────────────────────────────────────

export interface SongMatch {
  /** Song title */
  readonly title: string;
  /** Artist name(s) */
  readonly artist: string;
  /** Album name (if available) */
  readonly album?: string;
  /** Release date (if available, ISO format) */
  readonly releaseDate?: string;
  /** Provider's confidence score (0-100) */
  readonly confidence: number;
  /** Provider-specific external ID */
  readonly externalId?: string;
  /** Duration of the full track in seconds (if available) */
  readonly durationSeconds?: number;
  /** Genres (if available) */
  readonly genres?: readonly string[];
}

// ── Request / Result ────────────────────────────────────────────────────

export interface IdentifyRequest {
  /** Audio data in canonical WAV format (16kHz mono s16 PCM) */
  readonly audioData: Buffer;
  /** Duration of the audio clip in seconds (for validation) */
  readonly durationSeconds: number;
  /** Request ID for tracing (P9) */
  readonly requestId?: string;

  // ── Agentic Context (P15) ──
  /** Who is making this request */
  readonly actorType?: "user" | "agent" | "system";
  /** Actor identifier */
  readonly actorId?: string;
  /** If an agent, on whose behalf */
  readonly onBehalfOf?: string;

  // ── Trajectory Context (P18) ──
  /** Trajectory ID — same across all steps in a workflow */
  readonly trajectoryId?: string;
  /** Step index within the trajectory */
  readonly stepIndex?: number;
}

export interface IdentifyResult {
  /** Matched song (null if no match found — P11 graceful degradation) */
  readonly match: SongMatch | null;
  /** Whether a match was found */
  readonly matched: boolean;
  /** Provider-reported confidence (0-100, 0 if no match) */
  readonly confidence: number;
  /** Identification latency in ms */
  readonly latencyMs: number;
  /** Provider name */
  readonly provider: string;
  /** Request ID for correlation (P9) */
  readonly requestId: string;
  /** Audio clip duration that was analyzed */
  readonly clipDurationSeconds: number;
  /** Estimated cost in USD for this identification (P5) */
  readonly estimatedCostUsd: number;

  // ── Trajectory Context (P18) ──
  /** Trajectory ID passed through from request */
  readonly trajectoryId?: string;
  /** Step index passed through from request */
  readonly stepIndex?: number;
  /** Intent for this step (P17) — always "inform" */
  readonly intent: typeof IDENTIFY_INTENT;
}

// ── Cache Interface (P16) ───────────────────────────────────────────────

/**
 * Cache for song identification results (P16 — cognitive memory).
 *
 * Use case: dedup rapid re-taps. If the same user taps "Identify" twice
 * in quick succession, the second call can hit cache instead of re-sending
 * audio to the provider.
 *
 * Key strategy: hash of audio fingerprint (not raw audio).
 * TTL should be short (5-10 minutes) since the same song might play again
 * hours later in a different context.
 */
export interface IdentifyCache {
  /** Get cached result by audio hash */
  get(audioHash: string): Promise<IdentifyResult | null>;
  /** Cache a result by audio hash */
  set(audioHash: string, result: IdentifyResult): Promise<void>;
}

// ── Provider Interface ──────────────────────────────────────────────────

export interface SongIdentificationProvider {
  /** Provider name (e.g., "acrcloud", "audd", "mock") */
  readonly name: string;

  /**
   * Identify a song from audio data.
   *
   * Audio MUST be in canonical format (WAV 16kHz mono s16 PCM).
   * Clip should be 5-15 seconds for best results.
   *
   * Returns IdentifyResult with match=null on no match (not an error).
   *
   * @throws Error on provider communication failure, auth failure, or invalid audio
   */
  identify(request: IdentifyRequest): Promise<IdentifyResult>;
}

// ── Constants ───────────────────────────────────────────────────────────

/** Minimum audio clip duration for reliable identification */
export const MIN_CLIP_SECONDS = 3;

/** Maximum audio clip duration sent to provider */
export const MAX_CLIP_SECONDS = 15;

/** Default rate limit: identifications per user per hour */
export const IDENTIFY_RATE_LIMIT_PER_HOUR = 10;
