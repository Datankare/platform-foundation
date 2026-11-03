/**
 * platform/errors/external-service.ts — A paid or external dependency failed, and why (TASK-197)
 *
 * Before (audit D-5, D-8): a Google 403 (key restricted, billing off), a quota exhausted or an
 * ACRCloud in-body code (an HTTP 200 carrying "invalid key") ended as a plain Error, so the route
 * answered a 500 `internal.error` and wrote one log line: no metric, no alert, nothing that told
 * an operator the credential or the plan had to be fixed. And a 429 left after the retries was
 * classed permanent, so quota exhaustion looked like the client's fault.
 *
 * An ExternalServiceError names the service and the reason. `internalError` (./respond.ts)
 * answers it with the coded `service.unavailable` (503, the service named, never the upstream
 * text), and `externalFailure` (platform/observability/external-failure.ts) records it — a metric
 * for every failure, an alert for the ones a person must fix (ALERTING_REASONS).
 *
 * Dependency-free on purpose: the error path must not depend on anything that can fail.
 *
 * @module platform/errors
 */

/** Why an external call failed. */
export type ExternalFailureReason =
  /** The credential was refused: 401, a 403 that is not a quota, a wrong client secret. */
  | "credential"
  /** The plan or quota is exhausted (a 403 quota answer, ACRCloud 3003/3015). */
  | "quota"
  /** Throttled: a 429 (Retry-After honoured by the transport, then given up). */
  | "rate_limited"
  /** The provider is overloaded: 529, 503. */
  | "overloaded"
  /** The model the request names no longer exists (404 on a model endpoint, TASK-186/188). */
  | "model_retired"
  /** Any other 5xx, or no answer at all. */
  | "unavailable"
  /** No answer within the deadline. */
  | "timeout"
  /** An answer the platform cannot use: an error inside an HTTP 200, a malformed body. */
  | "bad_response"
  /** Any other 4xx: the request itself was refused. */
  | "rejected";

/** The reasons a person must act on (rotate a key, raise a plan, move to a new model). */
export const ALERTING_REASONS: ReadonlySet<ExternalFailureReason> = new Set([
  "credential",
  "quota",
  "model_retired",
]);

/** The reasons worth retrying later: the same request may succeed. */
export const TRANSIENT_REASONS: ReadonlySet<ExternalFailureReason> = new Set([
  "rate_limited",
  "overloaded",
  "unavailable",
  "timeout",
]);

/**
 * The reason for an HTTP status (the classification table — TASK-197 D-8). `notFound` is what a
 * 404 means for this endpoint: a model endpoint's 404 is a retired model; elsewhere it is the
 * request's. `body` (the provider's error text, never shown to anyone) separates a 403 quota
 * answer from a 403 credential answer.
 */
export function classifyHttpFailure(
  status: number,
  options: { readonly notFound?: ExternalFailureReason; readonly body?: string } = {}
): ExternalFailureReason {
  const body = options.body ?? "";
  // A per-minute (or per-second) limit is throttling the caller can wait out, whatever words the
  // body uses — Google's "Quota exceeded for quota metric 'Requests' and limit 'Requests per
  // minute'", rateLimitExceeded, RATE_LIMIT_EXCEEDED (review round 1, L-2). Quota exhaustion is the
  // plan's: a daily limit, an exhausted balance.
  const perMinute =
    /per[ _-]?(?:minute|second|100 seconds)|rate[ _]?limit[ _]?exceeded/i.test(body);
  const quota =
    /quota|RESOURCE_EXHAUSTED|billing.*(?:exceeded|limit)|dailyLimitExceeded/i.test(body);
  // Google answers a key that is not valid or has expired with 400 API_KEY_INVALID (L-3).
  if (
    status === 400 &&
    /API key (?:not valid|expired|is invalid)|API_KEY_INVALID|API_KEY_EXPIRED/i.test(body)
  ) {
    return "credential";
  }
  if (status === 401) return "credential";
  if (status === 403) return perMinute ? "rate_limited" : quota ? "quota" : "credential";
  if (status === 404) return options.notFound ?? "rejected";
  if (status === 408) return "timeout";
  if (status === 429)
    return perMinute ? "rate_limited" : quota ? "quota" : "rate_limited";
  if (status === 503 || status === 529) return "overloaded";
  if (status >= 500 || status === 0) return "unavailable";
  return "rejected";
}

export class ExternalServiceError extends Error {
  /** The service, as an id: "anthropic", "google-tts", "acrcloud", "cognito", "upstash"… */
  readonly service: string;
  readonly reason: ExternalFailureReason;
  /** The HTTP status, when there was one. */
  readonly status?: number;
  /** The provider's own code (an ACRCloud status code, a Cognito exception name), when known. */
  readonly providerCode?: string;

  constructor(
    service: string,
    reason: ExternalFailureReason,
    message: string,
    details: { readonly status?: number; readonly providerCode?: string } = {}
  ) {
    super(message);
    this.name = "ExternalServiceError";
    this.service = service;
    this.reason = reason;
    if (details.status !== undefined) this.status = details.status;
    if (details.providerCode !== undefined) this.providerCode = details.providerCode;
  }

  /** Worth retrying later. */
  get transient(): boolean {
    return TRANSIENT_REASONS.has(this.reason);
  }
}

/**
 * Whether `err` is an ExternalServiceError — also one from another bundled copy of this module
 * (Next.js can load one per route bundle, ADR-032), where `instanceof` is false.
 */
export function isExternalServiceError(err: unknown): err is ExternalServiceError {
  if (err instanceof ExternalServiceError) return true;
  if (!(err instanceof Error) || err.name !== "ExternalServiceError") return false;
  const e = err as { service?: unknown; reason?: unknown };
  return typeof e.service === "string" && typeof e.reason === "string";
}
