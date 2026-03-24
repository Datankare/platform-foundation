/**
 * lib/fetchWithTimeout.ts — Fetch wrapper with AbortController timeout
 *
 * Every external API call in the platform MUST use this wrapper instead
 * of raw fetch(). A hung upstream (DNS failure, network partition, API
 * degradation) would otherwise block the serverless function until
 * Vercel's hard timeout kills it.
 *
 * Default timeout: 10 seconds. Override per-call via options.timeoutMs.
 *
 * Phase 0.9 — addresses code review finding H-2.
 */

import { logger, generateRequestId } from "@/lib/logger";

export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs?: number;
}

export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const { timeoutMs = 10000, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      const requestId = generateRequestId();
      logger.error("External API call timed out", {
        requestId,
        route: "lib/fetchWithTimeout",
        durationMs: timeoutMs,
        error: `Request to ${new URL(url).hostname} timed out after ${timeoutMs}ms`,
      });
      throw new Error(`Request timed out after ${timeoutMs}ms: ${new URL(url).hostname}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
