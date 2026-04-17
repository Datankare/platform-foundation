/**
 * platform/voice/mock-identify.ts — Mock song identification provider
 *
 * Deterministic mock for testing. Returns predictable matches based on
 * configuration. Supports all principle fields (P5/P17/P18).
 *
 * GenAI Principles:
 *   P5  — estimatedCostUsd = 0 in results
 *   P10 — Testable: deterministic, zero external dependencies
 *   P11 — Graceful degradation: simulates both match and no-match paths
 *   P17 — IDENTIFY_INTENT in result
 *   P18 — trajectoryId/stepIndex passed through
 *
 * @module platform/voice
 */

import type {
  SongIdentificationProvider,
  IdentifyRequest,
  IdentifyResult,
  SongMatch,
} from "./identify-types";
import { IDENTIFY_INTENT } from "./identify-types";
import { generateRequestId } from "@/lib/logger";

// ── Default mock match ──────────────────────────────────────────────────

const MOCK_MATCH: SongMatch = {
  title: "Bohemian Rhapsody",
  artist: "Queen",
  album: "A Night at the Opera",
  releaseDate: "1975-10-31",
  confidence: 95,
  externalId: "mock-acrid-001",
  durationSeconds: 354,
  genres: ["Rock", "Progressive Rock"],
};

// ── Implementation ──────────────────────────────────────────────────────

export class MockSongIdentifier implements SongIdentificationProvider {
  readonly name = "mock";

  /** Track calls for test assertions */
  public identifyCalls: IdentifyRequest[] = [];

  /** If set, identify() will throw this error */
  public errorToThrow: Error | null = null;

  /** Custom match to return (null = no match) */
  public matchToReturn: SongMatch | null = MOCK_MATCH;

  /** Custom confidence override */
  public confidenceOverride: number | null = null;

  /** Simulated latency in ms */
  public simulatedLatencyMs = 0;

  /** If true, always return no match regardless of matchToReturn */
  public forceNoMatch = false;

  async identify(request: IdentifyRequest): Promise<IdentifyResult> {
    this.identifyCalls.push(request);

    if (this.errorToThrow) {
      throw this.errorToThrow;
    }

    if (this.simulatedLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedLatencyMs));
    }

    const requestId = request.requestId ?? generateRequestId();
    const match = this.forceNoMatch ? null : this.matchToReturn;
    const confidence = match ? (this.confidenceOverride ?? match.confidence) : 0;

    return {
      match,
      matched: match !== null,
      confidence,
      latencyMs: this.simulatedLatencyMs,
      provider: this.name,
      requestId,
      clipDurationSeconds: request.durationSeconds,
      estimatedCostUsd: 0,
      intent: IDENTIFY_INTENT,
      trajectoryId: request.trajectoryId,
      stepIndex: request.stepIndex,
    };
  }

  /** Reset all state */
  reset(): void {
    this.identifyCalls = [];
    this.errorToThrow = null;
    this.matchToReturn = MOCK_MATCH;
    this.confidenceOverride = null;
    this.simulatedLatencyMs = 0;
    this.forceNoMatch = false;
  }
}
