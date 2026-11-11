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
 * @module platform/voice/song-id
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
import {
  classifyHttpFailure,
  externalFailure,
  type ExternalFailureReason,
} from "@/platform/observability/external-failure";
import { logger, generateRequestId } from "@/lib/logger";
import { parseCreditAlertAt, recordAcrCloudRequest } from "./acrcloud-usage";

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
  private readonly creditAlertAt: number | undefined;

  constructor() {
    const config = getAcrCloudConfig();
    this.host = config.host;
    this.accessKey = config.accessKey;
    this.accessSecret = config.accessSecret;
    this.creditAlertAt = parseCreditAlertAt(config.creditAlertAt);
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
    const data = await this.sendRequest(formData, requestId, request);
    const latencyMs = Date.now() - start;

    // N-77: what ACRCloud bills — an answer with a result, or with none — is counted against the
    // prepaid credit's budget (./acrcloud-usage.ts). An error status is not a billed request.
    const code = data?.status?.code;
    if (code === 0 || code === 1001) {
      await recordAcrCloudRequest(
        code === 0 && data.metadata?.music?.[0] ? "result" : "no_result",
        this.creditAlertAt
      );
    }

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
    requestId: string,
    budget: Pick<IdentifyRequest, "timeoutMs" | "signal"> = {}
  ): Promise<ACRCloudResponse> {
    try {
      // A caller's budget (the health probe's) bounds the whole call: one attempt, no retry
      // past it (TASK-197 review round 3, N4).
      const response = await fetchWithTimeout(`https://${this.host}/v1/identify`, {
        method: "POST",
        body: formData,
        timeoutMs: budget.timeoutMs ?? API_TIMEOUT_MS,
        maxRetries: budget.timeoutMs === undefined ? 1 : 0,
        ...(budget.signal ? { signal: budget.signal } : {}),
      });

      if (!response.ok) {
        throw externalFailure(
          "acrcloud",
          classifyHttpFailure(response.status),
          `ACRCloud HTTP error: ${response.status} ${response.statusText}`,
          { status: response.status }
        );
      }

      return (await response.json()) as ACRCloudResponse;
    } catch (err) {
      logger.error("ACRCloudIdentifier: identification failed", {
        error: err instanceof Error ? err.message : String(err),
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
      // An error inside an HTTP 200 (audit D-5): a bad key or an exhausted plan must reach an
      // operator, not end as a 500 with a log line.
      throw externalFailure(
        "acrcloud",
        acrCloudFailureReason(data.status.code),
        `ACRCloud error: ${data.status.code} — ${data.status.msg}`,
        { providerCode: String(data.status.code) }
      );
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

/**
 * ACRCloud's in-body status codes (docs.acrcloud.com, "Error codes"): 3001 missing or invalid
 * access key, 3014 invalid signature (the secret), 3003 and 3015 the plan's call or rate limit,
 * 3000 their server; anything else (2004 an unreadable sample, 3006 bad parameters) is the
 * request's.
 */
export function acrCloudFailureReason(code: number): ExternalFailureReason {
  if (code === 3001 || code === 3014) return "credential";
  if (code === 3003 || code === 3015) return "quota";
  if (code === 3000) return "unavailable";
  return "rejected";
}

// ── Configuration (TASK-042 — single source of truth) ───────────────────────

/** ACRCloud credentials read from the environment. */
export interface AcrCloudConfig {
  readonly host: string;
  readonly accessKey: string;
  readonly accessSecret: string;
  /**
   * ACRCLOUD_CREDIT_ALERT_AT (TASK-212, N-77): the valid requests after which the prepaid credit
   * is to be topped up, as written ("" when unset); ./acrcloud-usage.ts parses it.
   */
  readonly creditAlertAt: string;
}

/**
 * The ONLY place ACRCLOUD_* environment variables are read (TASK-042).
 * Both the provider registry and ACRCloudIdentifier call this — do not read
 * process.env.ACRCLOUD_* anywhere else.
 */
export function getAcrCloudConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): AcrCloudConfig {
  return {
    host: env.ACRCLOUD_HOST ?? "",
    accessKey: env.ACRCLOUD_ACCESS_KEY ?? "",
    accessSecret: env.ACRCLOUD_ACCESS_SECRET ?? "",
    creditAlertAt: env.ACRCLOUD_CREDIT_ALERT_AT ?? "",
  };
}

/** True when all three ACRCloud credentials are present. */
export function isAcrCloudConfigured(): boolean {
  const c = getAcrCloudConfig();
  return Boolean(c.host && c.accessKey && c.accessSecret);
}
