/**
 * lib/fetchWithTimeout.ts — Fetch wrapper with timeout + retry
 *
 * Every external API call in the platform MUST use this wrapper instead
 * of raw fetch(). Handles:
 * - Timeout via AbortController (default 10s), over the whole exchange: the response's body
 *   is read under the same deadline as its headers
 * - The caller's own signal, kept: either one aborts the call
 * - Retry with exponential backoff for transient errors (429, 503, 529)
 *
 * Audit G-9. Before: the timer was cleared when the headers arrived, so a body that never
 * finished hung its caller with no timeout; the caller's `signal` was replaced by the wrapper's,
 * so the Redis cache's own timeouts never fired; and a request that timed out was sent again —
 * for a paid API, a timed-out request has usually been processed and billed, so the retry paid
 * twice. Now a timeout is retried only for a request that changes nothing (GET, HEAD) unless the
 * caller says it is safe (`retryOnTimeout`); a 429/503/529 (refused, not processed) is retried
 * as before. A streamed response (`stream: true`) is timed to its headers only; the caller's
 * signal bounds the stream.
 *
 * Phase 0.9 — addresses H-2. Sprint 7a — adds retry for transient failures.
 */

import { logger, generateRequestId } from "@/lib/logger";

const RETRYABLE_STATUS_CODES = new Set([429, 503, 529]);
const DEFAULT_MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;
const SAFE_METHODS = new Set(["GET", "HEAD"]);

export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Retry after a timeout even though the method may change something (a POST the provider
   * makes idempotent itself). Default: only GET and HEAD are.
   */
  retryOnTimeout?: boolean;
  /** The caller reads a stream: the timeout covers the headers only. */
  stream?: boolean;
}

/** Thrown when the caller's own signal aborted the call (never retried). */
function callerAbort(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const {
    timeoutMs = 10000,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryOnTimeout,
    stream = false,
    signal: callerSignal,
    ...fetchOptions
  } = options;
  const method = (fetchOptions.method ?? "GET").toUpperCase();
  const timeoutRetries = retryOnTimeout ?? SAFE_METHODS.has(method);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (callerSignal?.aborted) throw callerAbort(callerSignal);
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (callerSignal?.aborted) throw callerAbort(callerSignal);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    // The deadline does not keep the process alive on its own.
    (timeoutId as { unref?: () => void }).unref?.();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    let keepTimer = false;

    try {
      const response = await fetch(url, { ...fetchOptions, signal });

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
        // Release the refused attempt's connection.
        await response.body?.cancel().catch(() => undefined);
        continue;
      }

      // The body is read under the same deadline (the timer stays; it aborts a body that
      // stalls). A stream is the caller's to bound.
      keepTimer = !stream;
      return response;
    } catch (error) {
      if (callerSignal?.aborted) throw callerAbort(callerSignal);
      const aborted =
        controller.signal.aborted || (error as { name?: unknown })?.name === "AbortError";
      if (aborted) {
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
        // A request that may have been processed (and billed) is not sent again.
        if (attempt < maxRetries && timeoutRetries) continue;
        throw lastError;
      }
      throw error;
    } finally {
      if (!keepTimer) clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error("Fetch failed after retries");
}
