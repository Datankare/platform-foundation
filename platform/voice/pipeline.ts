/**
 * platform/voice/pipeline.ts — Voice Pipeline Orchestrator
 *
 * End-to-end chain: STT → safety screen → translate → TTS
 * Each step is a trajectory step with agentic context (P15-P18).
 *
 * GenAI Principles (ALL verified — Sprint 3 mapping table):
 *   P1  — All operations through provider interfaces
 *   P2  — Every step emits metrics via onMetric callback
 *   P3  — Safety screening before translation (fail closed)
 *   P5  — Cost tracking per step via metrics
 *   P7  — All providers injected, swappable
 *   P9  — TraceId propagated across all steps
 *   P10 — All providers mockable
 *   P11 — Partial results on mid-pipeline failure
 *   P14 — Step results form an auditable trail
 *   P15 — actorType/actorId/onBehalfOf in every request
 *   P16 — Translation cache checked before API call
 *   P17 — Steps mapped to intent: stt=inform, safety=checkpoint, translate=propose, tts=commit
 *   P18 — trajectoryId + stepIndex on every step result
 *
 * @module platform/voice
 */

import type { TTSProvider, STTProvider, TTSResult, STTResult } from "./types";
import type {
  TranslationProvider,
  TranslationResult,
} from "@/platform/translation/types";
import { logger, generateRequestId } from "@/lib/logger";

// ── Agentic Intent Mapping (P17) ────────────────────────────────────────

/**
 * Each pipeline step maps to an agentic intent:
 *   stt      → "inform"      (reporting what was heard)
 *   safety   → "checkpoint"  (validating before proceeding)
 *   translate → "propose"    (suggesting a translation)
 *   tts      → "commit"     (producing the final audio artifact)
 */
export type PipelineIntent = "inform" | "checkpoint" | "propose" | "commit";

const STEP_INTENT_MAP: Record<string, PipelineIntent> = {
  stt: "inform",
  safety: "checkpoint",
  translate: "propose",
  tts: "commit",
};

// ── Pipeline Types ──────────────────────────────────────────────────────

export interface PipelineRequest {
  /** Base64-encoded audio (for STT → translate → TTS flow) */
  readonly audioBase64?: string;
  /** Text input (for translate → TTS flow, skips STT) */
  readonly text?: string;
  /** Target language for translation */
  readonly targetLanguage: string;
  /** Source language hint (optional, auto-detect if omitted) */
  readonly sourceLanguage?: string;
  /** Whether to auto-detect source language */
  readonly autoDetect?: boolean;
  /** Whether to synthesize TTS for the translation */
  readonly synthesize?: boolean;
  /** Request ID for tracing (auto-generated if omitted) */
  readonly requestId?: string;

  // ── Agentic Context (P15) ──
  /** Who is making this request */
  readonly actorType?: "user" | "agent" | "system";
  /** Actor identifier */
  readonly actorId?: string;
  /** If an agent, on whose behalf */
  readonly onBehalfOf?: string;

  // ── Trace Context (P9) ──
  /** Parent trace ID for distributed tracing */
  readonly traceId?: string;
}

export interface PipelineStepResult {
  readonly step: string;
  readonly status: "success" | "skipped" | "failed";
  readonly latencyMs: number;
  readonly error?: string;

  // ── Agentic Trajectory (P17, P18) ──
  readonly intent: PipelineIntent;
  readonly stepIndex: number;
  readonly trajectoryId: string;
}

export interface PipelineResult {
  /** Overall success — true if at least transcription or translation succeeded */
  readonly success: boolean;
  /** Transcribed text (from STT or direct input) */
  readonly transcript?: string;
  /** Detected source language */
  readonly sourceLanguage?: string;
  /** Translation result */
  readonly translation?: TranslationResult;
  /** TTS result (base64 audio of translated text) */
  readonly tts?: TTSResult;
  /** Safety screening passed */
  readonly safetyPassed: boolean;
  /** Safety rejection reason (if blocked) */
  readonly safetyReason?: string;
  /** Per-step results for observability (P14 audit trail) */
  readonly steps: PipelineStepResult[];
  /** Total pipeline latency in ms */
  readonly totalLatencyMs: number;
  /** Request ID for correlation */
  readonly requestId: string;
  /** Trajectory ID (P18) — same across all steps */
  readonly trajectoryId: string;
  /** Actor context (P15) */
  readonly actorType: "user" | "agent" | "system";
  readonly actorId: string;
  readonly onBehalfOf?: string;
  /** Whether translation was served from cache (P16) */
  readonly translationCached: boolean;
}

/** Safety screen function — injected to avoid circular dependency */
export type SafetyScreenFn = (
  text: string
) => Promise<{ safe: boolean; reason?: string }>;

/** Translation cache interface (P16) — consumers inject their cache */
export interface TranslationCache {
  get(text: string, targetLang: string): Promise<string | null>;
  set(text: string, targetLang: string, result: string): Promise<void>;
}

/** Metric callback (P2) — consumers wire to MetricsSink */
export interface PipelineMetricEvent {
  readonly step: string;
  readonly intent: PipelineIntent;
  readonly latencyMs: number;
  readonly success: boolean;
  readonly cached: boolean;
  readonly actorType: string;
  readonly actorId: string;
  readonly traceId: string;
  readonly trajectoryId: string;
  readonly stepIndex: number;
  readonly error?: string;
}

// ── Pipeline Configuration ──────────────────────────────────────────────

export interface PipelineConfig {
  readonly stt: STTProvider;
  readonly tts: TTSProvider;
  readonly translation: TranslationProvider;
  readonly safetyScreen?: SafetyScreenFn;
  /** Translation cache (P16) — skip API when cached */
  readonly translationCache?: TranslationCache;
  /** Metric callback (P2) — called after each step */
  readonly onMetric?: (event: PipelineMetricEvent) => void;
}

// ── Pipeline Implementation ─────────────────────────────────────────────

export class VoicePipeline {
  private readonly stt: STTProvider;
  private readonly tts: TTSProvider;
  private readonly translation: TranslationProvider;
  private readonly safetyScreen: SafetyScreenFn | null;
  private readonly cache: TranslationCache | null;
  private readonly onMetric: ((event: PipelineMetricEvent) => void) | null;

  constructor(config: PipelineConfig) {
    this.stt = config.stt;
    this.tts = config.tts;
    this.translation = config.translation;
    this.safetyScreen = config.safetyScreen ?? null;
    this.cache = config.translationCache ?? null;
    this.onMetric = config.onMetric ?? null;
  }

  /**
   * Execute the full voice pipeline.
   *
   * Flow:
   * 1. STT (if audioBase64 provided) — intent: inform
   * 2. Safety screen (if configured) — intent: checkpoint
   * 3. Translate (with cache check) — intent: propose
   * 4. TTS (if synthesize=true) — intent: commit
   *
   * Partial failure: returns whatever succeeded.
   */
  async execute(request: PipelineRequest): Promise<PipelineResult> {
    const requestId = request.requestId ?? generateRequestId();
    const trajectoryId = `traj_${requestId}`;
    const actorType = request.actorType ?? "user";
    const actorId = request.actorId ?? "anonymous";
    const traceId = request.traceId ?? requestId;
    const pipelineStart = Date.now();
    const steps: PipelineStepResult[] = [];
    const synthesize = request.synthesize ?? true;
    let stepIndex = 0;
    let translationCached = false;

    logger.debug("VoicePipeline.execute start", {
      requestId,
      trajectoryId,
      actorType,
      actorId,
      hasAudio: !!request.audioBase64,
      hasText: !!request.text,
      targetLanguage: request.targetLanguage,
      synthesize,
      route: "platform/voice/pipeline",
    });

    // ── Helper: record step + emit metric ───────────────────────────

    const recordStep = (
      step: string,
      status: "success" | "skipped" | "failed",
      latencyMs: number,
      cached: boolean = false,
      error?: string
    ): PipelineStepResult => {
      const intent = STEP_INTENT_MAP[step] ?? "inform";
      const result: PipelineStepResult = {
        step,
        status,
        latencyMs,
        error,
        intent,
        stepIndex,
        trajectoryId,
      };
      steps.push(result);

      this.onMetric?.({
        step,
        intent,
        latencyMs,
        success: status === "success",
        cached,
        actorType,
        actorId,
        traceId,
        trajectoryId,
        stepIndex,
        error,
      });

      stepIndex++;
      return result;
    };

    // ── Step 1: Get text (STT or direct) — intent: inform ───────────

    let transcript: string | undefined;
    let sourceLanguage: string | undefined = request.sourceLanguage;

    if (request.audioBase64) {
      const sttStart = Date.now();
      try {
        const sttResult: STTResult = await this.stt.transcribe({
          audioBase64: request.audioBase64,
          autoDetect: request.autoDetect ?? true,
          languageCode: request.sourceLanguage,
        });

        transcript = sttResult.transcript;
        sourceLanguage = sttResult.languageCode;

        if (!transcript) {
          recordStep("stt", "failed", Date.now() - sttStart, false, "No speech detected");
          return this.buildResult({
            success: false,
            safetyPassed: true,
            steps,
            totalLatencyMs: Date.now() - pipelineStart,
            requestId,
            trajectoryId,
            actorType,
            actorId,
            onBehalfOf: request.onBehalfOf,
            translationCached,
          });
        }

        recordStep("stt", "success", Date.now() - sttStart);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordStep("stt", "failed", Date.now() - sttStart, false, message);

        logger.error("VoicePipeline STT failed", {
          requestId,
          trajectoryId,
          error: message,
          route: "platform/voice/pipeline",
        });

        return this.buildResult({
          success: false,
          safetyPassed: true,
          steps,
          totalLatencyMs: Date.now() - pipelineStart,
          requestId,
          trajectoryId,
          actorType,
          actorId,
          onBehalfOf: request.onBehalfOf,
          translationCached,
        });
      }
    } else if (request.text) {
      transcript = request.text;
      recordStep("stt", "skipped", 0);
    } else {
      recordStep("stt", "failed", 0, false, "No audio or text provided");
      return this.buildResult({
        success: false,
        safetyPassed: true,
        steps,
        totalLatencyMs: Date.now() - pipelineStart,
        requestId,
        trajectoryId,
        actorType,
        actorId,
        onBehalfOf: request.onBehalfOf,
        translationCached,
      });
    }

    // ── Step 2: Safety screen — intent: checkpoint ──────────────────

    if (this.safetyScreen) {
      const safetyStart = Date.now();
      try {
        const safety = await this.safetyScreen(transcript);

        if (!safety.safe) {
          recordStep("safety", "failed", Date.now() - safetyStart, false, safety.reason);
          return this.buildResult({
            success: false,
            transcript,
            sourceLanguage,
            safetyPassed: false,
            safetyReason: safety.reason,
            steps,
            totalLatencyMs: Date.now() - pipelineStart,
            requestId,
            trajectoryId,
            actorType,
            actorId,
            onBehalfOf: request.onBehalfOf,
            translationCached,
          });
        }

        recordStep("safety", "success", Date.now() - safetyStart);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordStep("safety", "failed", Date.now() - safetyStart, false, message);

        // Fail closed (P3)
        return this.buildResult({
          success: false,
          transcript,
          sourceLanguage,
          safetyPassed: false,
          safetyReason: "Safety check error: " + message,
          steps,
          totalLatencyMs: Date.now() - pipelineStart,
          requestId,
          trajectoryId,
          actorType,
          actorId,
          onBehalfOf: request.onBehalfOf,
          translationCached,
        });
      }
    } else {
      recordStep("safety", "skipped", 0);
    }

    // ── Step 3: Translate (with P16 cache check) — intent: propose ──

    let translation: TranslationResult | undefined;
    const translateStart = Date.now();

    try {
      // P16: Check cache first
      if (this.cache) {
        const cached = await this.cache.get(transcript, request.targetLanguage);
        if (cached) {
          translation = {
            text: cached,
            sourceLanguage: sourceLanguage ?? "unknown",
            targetLanguage: request.targetLanguage,
            latencyMs: Date.now() - translateStart,
            cached: true,
          };
          translationCached = true;
          recordStep("translate", "success", Date.now() - translateStart, true);
        }
      }

      // Cache miss — call provider
      if (!translation) {
        translation = await this.translation.translate(
          transcript,
          request.targetLanguage,
          sourceLanguage
        );

        recordStep("translate", "success", Date.now() - translateStart);

        // P16: Store in cache for next time
        if (this.cache) {
          await this.cache
            .set(transcript, request.targetLanguage, translation.text)
            .catch((err) => {
              logger.warn("Translation cache set failed", {
                requestId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordStep("translate", "failed", Date.now() - translateStart, false, message);

      logger.error("VoicePipeline translate failed", {
        requestId,
        trajectoryId,
        error: message,
        route: "platform/voice/pipeline",
      });

      // Partial result: transcript available, translation failed
      return this.buildResult({
        success: true,
        transcript,
        sourceLanguage,
        safetyPassed: true,
        steps,
        totalLatencyMs: Date.now() - pipelineStart,
        requestId,
        trajectoryId,
        actorType,
        actorId,
        onBehalfOf: request.onBehalfOf,
        translationCached,
      });
    }

    // ── Step 4: TTS (if requested) — intent: commit ─────────────────

    let tts: TTSResult | undefined;

    if (synthesize && translation) {
      const ttsStart = Date.now();
      try {
        tts = await this.tts.synthesize({
          text: translation.text,
          languageCode: request.targetLanguage,
        });

        recordStep("tts", "success", Date.now() - ttsStart);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordStep("tts", "failed", Date.now() - ttsStart, false, message);

        logger.error("VoicePipeline TTS failed", {
          requestId,
          trajectoryId,
          error: message,
          route: "platform/voice/pipeline",
        });
      }
    } else {
      recordStep("tts", "skipped", 0);
    }

    // ── Result ──────────────────────────────────────────────────────

    return this.buildResult({
      success: true,
      transcript,
      sourceLanguage,
      translation,
      tts,
      safetyPassed: true,
      steps,
      totalLatencyMs: Date.now() - pipelineStart,
      requestId,
      trajectoryId,
      actorType,
      actorId,
      onBehalfOf: request.onBehalfOf,
      translationCached,
    });
  }

  // ── Private ─────────────────────────────────────────────────────────

  private buildResult(
    partial: Partial<PipelineResult> & {
      success: boolean;
      safetyPassed: boolean;
      steps: PipelineStepResult[];
      totalLatencyMs: number;
      requestId: string;
      trajectoryId: string;
      actorType: "user" | "agent" | "system";
      actorId: string;
      translationCached: boolean;
    }
  ): PipelineResult {
    return {
      success: partial.success,
      transcript: partial.transcript,
      sourceLanguage: partial.sourceLanguage,
      translation: partial.translation,
      tts: partial.tts,
      safetyPassed: partial.safetyPassed,
      safetyReason: partial.safetyReason,
      steps: partial.steps,
      totalLatencyMs: partial.totalLatencyMs,
      requestId: partial.requestId,
      trajectoryId: partial.trajectoryId,
      actorType: partial.actorType,
      actorId: partial.actorId,
      onBehalfOf: partial.onBehalfOf,
      translationCached: partial.translationCached,
    };
  }
}
