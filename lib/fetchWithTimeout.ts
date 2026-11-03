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
 *
 * TASK-197 (audit D-8): the waits were a fixed 0.5 s then 1 s — every client of a throttled
 * provider retried in lockstep, and a `Retry-After` was ignored. Now each wait is the exponential
 * step with jitter (half the step plus a random part of the other half), and a refused answer's
 * `Retry-After` (seconds or an HTTP date) is honoured, with a little jitter of its own. It is
 * bounded: a provider asking for longer than MAX_RETRY_AFTER_MS is not waited for — the refused
 * answer is returned to the caller, which classifies it (a 429 is transient, never the client's
 * fault — platform/errors/external-service.ts).
 *
 * Review round 1 (L-4): a wait ends at once when the caller's signal aborts; all the waits of one
 * call add up to at most MAX_TOTAL_RETRY_WAIT_MS (a refusal beyond it is returned, not waited
 * out); a timeout's retry never inherits an earlier refusal's Retry-After. A route's own time
 * limit is the host's: on Vercel the functions run with fluid compute (a 300 s default, well above
 * a call's 10 s timeout plus 10 s of waits); a host with a shorter limit sets `maxDuration`.
 */

import { logger, generateRequestId } from "@/lib/logger";

const RETRYABLE_STATUS_CODES = new Set([429, 503, 529]);
const DEFAULT_MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;
const SAFE_METHODS = new Set(["GET", "HEAD"]);
/** The longest Retry-After waited for; a longer one returns the refused answer instead. */
export const MAX_RETRY_AFTER_MS = 10_000;

/** The most one call waits between its attempts, all retries together (review round 1, L-4). */
export const MAX_TOTAL_RETRY_WAIT_MS = 10_000;

/** Wait `ms`, or until `signal` aborts (whichever is first). */
function sleepUnless(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** A uniform number in [0, 1) for jitter (Web Crypto: no insecure randomness in the platform). */
function jitter(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

/** A Retry-After value in milliseconds (delta-seconds or an HTTP date), or null when unusable. */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now()
): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * The wait before retry number `attempt` (1-based): the exponential step with jitter, or the
 * provider's Retry-After (plus up to 10%, at most 250 ms, of jitter) when it gave one. Null when
 * the Retry-After is longer than MAX_RETRY_AFTER_MS: not retried.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  random: () => number = jitter
): number | null {
  const step = BASE_DELAY_MS * Math.pow(2, attempt - 1);
  const jittered = step / 2 + random() * (step / 2);
  if (retryAfterMs === null) return Math.round(jittered);
  if (retryAfterMs > MAX_RETRY_AFTER_MS) return null;
  return Math.round(retryAfterMs + random() * Math.min(retryAfterMs * 0.1, 250));
}

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

/**
 * The call got no answer within its deadline (TASK-197: typed, so a caller classifies a timeout
 * as transient by its type, not by matching the message text).
 */
export class FetchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchTimeoutError";
  }
}

/** Whether `err` is a FetchTimeoutError — also one from another bundled copy (by name). */
export function isFetchTimeoutError(err: unknown): err is FetchTimeoutError {
  return err instanceof Error && err.name === "FetchTimeoutError";
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
  // The refused attempt's Retry-After, in ms (null: none given).
  let retryAfterMs: number | null = null;
  // TASK-197 review round 1 (L-4): the waits of one call add up to at most MAX_TOTAL_RETRY_WAIT_MS.
  let waited = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (callerSignal?.aborted) throw callerAbort(callerSignal);
    if (attempt > 0) {
      const delay = retryDelayMs(attempt, retryAfterMs) ?? 0;
      // A wait never outlives the caller: its signal ends the sleep at once (L-4).
      await sleepUnless(delay, callerSignal);
      waited += delay;
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

      const askedWait = RETRYABLE_STATUS_CODES.has(response.status)
        ? parseRetryAfter(response.headers?.get?.("retry-after") ?? null)
        : null;
      const nextWait = retryDelayMs(attempt + 1, askedWait);
      if (
        RETRYABLE_STATUS_CODES.has(response.status) &&
        attempt < maxRetries &&
        nextWait !== null &&
        waited + nextWait <= MAX_TOTAL_RETRY_WAIT_MS
      ) {
        retryAfterMs = askedWait;
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
        lastError = new FetchTimeoutError(
          `Request timed out after ${timeoutMs}ms: ${new URL(url).hostname}`
        );
        // A request that may have been processed (and billed) is not sent again. A timeout's own
        // retry waits the exponential step, never an earlier refusal's Retry-After (L-4).
        retryAfterMs = null;
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
