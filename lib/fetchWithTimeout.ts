/**
 * lib/fetchWithTimeout.ts — Fetch wrapper with timeout + retry
 *
 * Every external API call in the platform MUST use this wrapper instead
 * of raw fetch(). Handles:
 * - Timeout via AbortController (default 10s)
 * - Retry with exponential backoff for transient errors (429, 503, 529)
 *
 * Phase 0.9 — addresses H-2. Sprint 7a — adds retry for transient failures.
 */

import { logger, generateRequestId } from "@/lib/logger";

const RETRYABLE_STATUS_CODES = new Set([429, 503, 529]);
const DEFAULT_MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;

export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
}

export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const {
    timeoutMs = 10000,
    maxRetries = DEFAULT_MAX_RETRIES,
    ...fetchOptions
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });

      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries) {
        const requestId = generateRequestId();
        logger.warn("Retryable API error — will retry", {
          requestId,
          route: "lib/fetchWithTimeout",
          status: response.status,
          attempt: attempt + 1,
          maxRetries,
          host: new URL(url).hostname,
        });
        lastError = new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
        continue;
      }

      return response;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        const requestId = generateRequestId();
        logger.error("External API call timed out", {
          requestId,
          route: "lib/fetchWithTimeout",
          durationMs: timeoutMs,
          attempt: attempt + 1,
          error: `Request to ${new URL(url).hostname} timed out after ${timeoutMs}ms`,
        });
        lastError = new Error(
          `Request timed out after ${timeoutMs}ms: ${new URL(url).hostname}`
        );
        if (attempt < maxRetries) continue;
        throw lastError;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error("Fetch failed after retries");
}
