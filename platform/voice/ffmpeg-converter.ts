/**
 * platform/voice/ffmpeg-converter.ts — FFmpeg service audio converter
 *
 * Calls the deployed ffmpeg microservice at AUDIO_CONVERTER_URL to convert
 * audio to the platform canonical format (WAV 16kHz mono s16 PCM).
 *
 * Uses fetchWithTimeout (not raw fetch) per platform convention.
 *
 * Infrastructure:
 *   Service: https://ffmpeg.datankare.com (ECS Fargate, us-east-1)
 *   Auth: X-Service-Key header (AUDIO_CONVERTER_KEY env var)
 *   Limits: 10MB max input, 30s timeout
 *
 * GenAI Principles:
 *   P1  — All conversion through provider interface
 *   P2  — Latency + size metrics returned in result
 *   P3  — Canonical conversion strips all container metadata
 *   P5  — estimatedCostUsd in result (self-hosted = $0)
 *   P7  — Swappable via AUDIO_CONVERTER env var
 *   P9  — requestId propagated to service for tracing
 *   P12 — Metadata stripped server-side during format conversion
 *
 * @module platform/voice
 */

import type {
  AudioFormatConverter,
  ConversionRequest,
  ConversionResult,
  SourceAudioFormat,
} from "./audio-format-types";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { logger } from "@/lib/logger";

// ── Constants ───────────────────────────────────────────────────────────

const SUPPORTED_FORMATS: SourceAudioFormat[] = [
  "webm",
  "mp3",
  "ogg",
  "flac",
  "wav",
  "opus",
];

/** Maximum audio input size in bytes (10MB) */
const MAX_INPUT_BYTES = 10 * 1024 * 1024;

/** HTTP timeout for conversion requests (30 seconds) */
const CONVERT_TIMEOUT_MS = 30_000;

// ── Implementation ──────────────────────────────────────────────────────

export class FfmpegServiceConverter implements AudioFormatConverter {
  readonly name = "ffmpeg-service";

  private readonly baseUrl: string;
  private readonly serviceKey: string;

  constructor() {
    this.baseUrl = process.env.AUDIO_CONVERTER_URL ?? "";
    this.serviceKey = process.env.AUDIO_CONVERTER_KEY ?? "";
  }

  async convert(request: ConversionRequest): Promise<ConversionResult> {
    const start = Date.now();
    const { audioData, sourceFormat, requestId } = request;

    this.validate(audioData, sourceFormat);

    const url = `${this.baseUrl}/convert`;

    logger.debug("FfmpegServiceConverter: converting audio", {
      sourceFormat,
      inputBytes: audioData.length,
      requestId,
      route: "platform/voice/ffmpeg-converter",
    });

    const response = await this.sendRequest(url, audioData, sourceFormat, requestId);
    return this.buildResult(response, audioData, sourceFormat, start);
  }

  supportsFormat(format: SourceAudioFormat): boolean {
    return SUPPORTED_FORMATS.includes(format);
  }

  getSupportedFormats(): SourceAudioFormat[] {
    return [...SUPPORTED_FORMATS];
  }

  // ── Private ───────────────────────────────────────────────────────

  private validate(audioData: Buffer, sourceFormat: SourceAudioFormat): void {
    if (!this.baseUrl) {
      throw new Error("AUDIO_CONVERTER_URL not configured — cannot convert audio");
    }
    if (!this.serviceKey) {
      throw new Error(
        "AUDIO_CONVERTER_KEY not configured — cannot authenticate with ffmpeg service"
      );
    }
    if (audioData.length > MAX_INPUT_BYTES) {
      throw new Error(
        `Audio exceeds maximum size: ${audioData.length} bytes (limit: ${MAX_INPUT_BYTES})`
      );
    }
    if (!this.supportsFormat(sourceFormat)) {
      throw new Error(`Unsupported source format: ${sourceFormat}`);
    }
  }

  private async sendRequest(
    url: string,
    audioData: Buffer,
    sourceFormat: SourceAudioFormat,
    requestId?: string
  ): Promise<Response> {
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "X-Service-Key": this.serviceKey,
          "X-Source-Format": sourceFormat,
          "Content-Type": "application/octet-stream",
          ...(requestId ? { "X-Request-Id": requestId } : {}),
        },
        body: new Uint8Array(audioData),
        timeoutMs: CONVERT_TIMEOUT_MS,
        maxRetries: 1,
      });

      if (!response.ok) {
        this.handleHttpError(response.status, response.statusText, audioData.length);
      }

      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("FfmpegServiceConverter: conversion failed", {
        error: message,
        sourceFormat,
        inputBytes: audioData.length,
        requestId,
        route: "platform/voice/ffmpeg-converter",
      });
      throw err;
    }
  }

  private handleHttpError(status: number, statusText: string, inputBytes: number): never {
    if (status === 401) {
      throw new Error("FFmpeg service authentication failed (401)");
    }
    if (status === 408) {
      throw new Error("FFmpeg service conversion timed out (408)");
    }
    if (status === 413) {
      throw new Error(
        `Audio exceeds ffmpeg service size limit (413): ${inputBytes} bytes`
      );
    }
    if (status === 422) {
      throw new Error("FFmpeg conversion failed (422): unable to process audio");
    }
    throw new Error(`FFmpeg service error: ${status} ${statusText}`);
  }

  private async buildResult(
    response: Response,
    audioData: Buffer,
    sourceFormat: SourceAudioFormat,
    startMs: number
  ): Promise<ConversionResult> {
    const outputBuffer = Buffer.from(await response.arrayBuffer());
    const latencyMs = Date.now() - startMs;

    logger.debug("FfmpegServiceConverter: conversion complete", {
      sourceFormat,
      inputBytes: audioData.length,
      outputBytes: outputBuffer.length,
      conversionMs: response.headers.get("X-Conversion-Ms"),
      totalLatencyMs: latencyMs,
      route: "platform/voice/ffmpeg-converter",
    });

    return {
      audioData: outputBuffer,
      sourceFormat,
      converted: true,
      latencyMs,
      sourceSizeBytes: audioData.length,
      outputSizeBytes: outputBuffer.length,
      estimatedCostUsd: 0, // Self-hosted service, no per-call cost
    };
  }
}
