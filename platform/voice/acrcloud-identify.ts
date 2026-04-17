/**
 * platform/voice/acrcloud-identify.ts — ACRCloud song identification
 *
 * Implements SongIdentificationProvider using ACRCloud's audio fingerprint API.
 * Signs requests with HMAC-SHA1 per ACRCloud's authentication protocol.
 * Uses fetchWithTimeout per platform convention.
 *
 * Privacy Controls:
 *   - Receives ONLY canonical WAV (metadata already stripped)
 *   - Sends only audio bytes + auth — no user/session/device info
 *   - Audio is not stored; used only for fingerprint matching
 *   - Clips enforced to MAX_CLIP_SECONDS
 *
 * GenAI Principles:
 *   P1  — All identification through provider interface
 *   P2  — Latency, confidence, clip size in every result
 *   P3  — No user metadata sent to ACRCloud
 *   P5  — estimatedCostUsd in result (~$0.01 per call on paid tier)
 *   P9  — requestId traced through logs
 *   P11 — No match = null result, not an error
 *   P15 — actorType/actorId logged for audit (never sent to ACRCloud)
 *   P17 — IDENTIFY_INTENT in result
 *   P18 — trajectoryId/stepIndex passed through
 *
 * @module platform/voice
 */

import { createHmac } from "crypto";
import type {
  SongIdentificationProvider,
  IdentifyRequest,
  IdentifyResult,
  SongMatch,
} from "./identify-types";
import { MIN_CLIP_SECONDS, MAX_CLIP_SECONDS, IDENTIFY_INTENT } from "./identify-types";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { logger, generateRequestId } from "@/lib/logger";

// ── Constants ───────────────────────────────────────────────────────────

const API_TIMEOUT_MS = 15_000;
const DATA_TYPE = "audio";
const SIGNATURE_VERSION = "1";

/** Estimated cost per identification on ACRCloud paid tier */
const ESTIMATED_COST_PER_CALL_USD = 0.01;

/** Canonical format: 16kHz mono 16-bit = 32,000 bytes/second */
const BYTES_PER_SECOND = 32_000;

/** WAV header size in bytes */
const WAV_HEADER_SIZE = 44;

// ── ACRCloud Response Types ─────────────────────────────────────────────

interface ACRCloudMusic {
  readonly title?: string;
  readonly artists?: ReadonlyArray<{ readonly name: string }>;
  readonly album?: { readonly name?: string };
  readonly release_date?: string;
  readonly duration_ms?: number;
  readonly genres?: ReadonlyArray<{ readonly name: string }>;
  readonly score?: number;
  readonly acrid?: string;
}

interface ACRCloudResponse {
  readonly status: {
    readonly code: number;
    readonly msg: string;
  };
  readonly metadata?: {
    readonly music?: readonly ACRCloudMusic[];
  };
}

// ── Implementation ──────────────────────────────────────────────────────

export class ACRCloudIdentifier implements SongIdentificationProvider {
  readonly name = "acrcloud";

  private readonly host: string;
  private readonly accessKey: string;
  private readonly accessSecret: string;

  constructor() {
    this.host = process.env.ACRCLOUD_HOST ?? "";
    this.accessKey = process.env.ACRCLOUD_ACCESS_KEY ?? "";
    this.accessSecret = process.env.ACRCLOUD_ACCESS_SECRET ?? "";
  }

  async identify(request: IdentifyRequest): Promise<IdentifyResult> {
    const start = Date.now();
    const requestId = request.requestId ?? generateRequestId();

    this.validateConfig();
    this.validateAudio(request);

    const audioPayload = this.enforceClipLimit(request.audioData);
    const clipDuration = Math.min(request.durationSeconds, MAX_CLIP_SECONDS);

    logger.debug("ACRCloudIdentifier: sending identification request", {
      requestId,
      clipBytes: audioPayload.length,
      clipDurationSeconds: clipDuration,
      actorType: request.actorType ?? "user",
      actorId: request.actorId ?? "anonymous",
      route: "platform/voice/acrcloud-identify",
    });

    const formData = this.buildSignedFormData(audioPayload);
    const data = await this.sendRequest(formData, requestId);
    const latencyMs = Date.now() - start;

    return this.parseResponse(data, {
      latencyMs,
      requestId,
      clipDuration,
      trajectoryId: request.trajectoryId,
      stepIndex: request.stepIndex,
    });
  }

  // ── Validation ────────────────────────────────────────────────────

  private validateConfig(): void {
    if (!this.host || !this.accessKey || !this.accessSecret) {
      throw new Error(
        "ACRCloud not configured — set ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY, ACRCLOUD_ACCESS_SECRET"
      );
    }
  }

  private validateAudio(request: IdentifyRequest): void {
    if (request.audioData.length === 0) {
      throw new Error("Audio data is empty");
    }
    if (request.durationSeconds < MIN_CLIP_SECONDS) {
      throw new Error(
        `Audio clip too short: ${request.durationSeconds}s (minimum: ${MIN_CLIP_SECONDS}s)`
      );
    }
  }

  private enforceClipLimit(audioData: Buffer): Buffer {
    const maxBytes = MAX_CLIP_SECONDS * BYTES_PER_SECOND;
    return audioData.length > maxBytes + WAV_HEADER_SIZE
      ? audioData.subarray(0, maxBytes + WAV_HEADER_SIZE)
      : audioData;
  }

  // ── Request Building ──────────────────────────────────────────────

  /** Build HMAC-SHA1 signed multipart form for ACRCloud API */
  private buildSignedFormData(audioPayload: Buffer): FormData {
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const stringToSign = [
      "POST",
      "/v1/identify",
      this.accessKey,
      DATA_TYPE,
      SIGNATURE_VERSION,
      timestamp,
    ].join("\n");

    const signature = createHmac("sha1", this.accessSecret)
      .update(stringToSign)
      .digest("base64");

    const formData = new FormData();
    formData.append("access_key", this.accessKey);
    formData.append("data_type", DATA_TYPE);
    formData.append("signature_version", SIGNATURE_VERSION);
    formData.append("signature", signature);
    formData.append("sample_bytes", audioPayload.length.toString());
    formData.append("timestamp", timestamp);
    formData.append(
      "sample",
      new Blob([new Uint8Array(audioPayload)], { type: "audio/wav" }),
      "sample.wav"
    );

    return formData;
  }

  // ── HTTP ──────────────────────────────────────────────────────────

  private async sendRequest(
    formData: FormData,
    requestId: string
  ): Promise<ACRCloudResponse> {
    try {
      const response = await fetchWithTimeout(`https://${this.host}/v1/identify`, {
        method: "POST",
        body: formData,
        timeoutMs: API_TIMEOUT_MS,
        maxRetries: 1,
      });

      if (!response.ok) {
        throw new Error(`ACRCloud HTTP error: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as ACRCloudResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("ACRCloudIdentifier: identification failed", {
        error: message,
        requestId,
        route: "platform/voice/acrcloud-identify",
      });
      throw err;
    }
  }

  // ── Response Parsing ──────────────────────────────────────────────

  private parseResponse(
    data: ACRCloudResponse,
    context: {
      latencyMs: number;
      requestId: string;
      clipDuration: number;
      trajectoryId?: string;
      stepIndex?: number;
    }
  ): IdentifyResult {
    const base = {
      latencyMs: context.latencyMs,
      provider: this.name as string,
      requestId: context.requestId,
      clipDurationSeconds: context.clipDuration,
      estimatedCostUsd: ESTIMATED_COST_PER_CALL_USD,
      intent: IDENTIFY_INTENT,
      trajectoryId: context.trajectoryId,
      stepIndex: context.stepIndex,
    };

    // ACRCloud status: 0 = match, 1001 = no match, others = error
    if (data.status.code === 1001) {
      logger.debug("ACRCloudIdentifier: no match found", {
        requestId: context.requestId,
        latencyMs: context.latencyMs,
        route: "platform/voice/acrcloud-identify",
      });
      return { match: null, matched: false, confidence: 0, ...base };
    }

    if (data.status.code !== 0) {
      throw new Error(`ACRCloud error: ${data.status.code} — ${data.status.msg}`);
    }

    const music = data.metadata?.music?.[0];
    if (!music) {
      return { match: null, matched: false, confidence: 0, ...base };
    }

    const match = this.mapToSongMatch(music);

    logger.debug("ACRCloudIdentifier: match found", {
      requestId: context.requestId,
      title: match.title,
      artist: match.artist,
      confidence: match.confidence,
      latencyMs: context.latencyMs,
      route: "platform/voice/acrcloud-identify",
    });

    return { match, matched: true, confidence: match.confidence, ...base };
  }

  private mapToSongMatch(music: ACRCloudMusic): SongMatch {
    return {
      title: music.title ?? "Unknown",
      artist: music.artists?.map((a) => a.name).join(", ") ?? "Unknown",
      album: music.album?.name,
      releaseDate: music.release_date,
      confidence: music.score ?? 0,
      externalId: music.acrid,
      durationSeconds: music.duration_ms
        ? Math.round(music.duration_ms / 1000)
        : undefined,
      genres: music.genres?.map((g) => g.name),
    };
  }
}
