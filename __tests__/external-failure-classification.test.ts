/**
 * TASK-197 (audit D-4, D-5, D-8): how an external failure is classified, recorded and answered.
 *
 *   - the classification table: 429 and 529 are transient (a 429 is throttling, never the
 *     client's fault), 401 and 403 a credential (a 403 quota answer is quota), 404 on a model
 *     endpoint a retired model;
 *   - externalFailure records a metric for every failure and an alert for a credential, a quota
 *     or a retired model;
 *   - a route's internalError answers an external failure with the coded service.unavailable
 *     (503, the service named), never internal.error and never the provider's text;
 *   - retries: jittered exponential waits, Retry-After honoured and bounded.
 */

jest.mock("@/platform/observability/alert", () => ({ raiseAlert: jest.fn() }));

import { raiseAlert } from "@/platform/observability/alert";
import {
  classifyHttpFailure,
  externalFailure,
  ExternalServiceError,
  isExternalServiceError,
  readFailureText,
  reportExternalFailure,
  resetExternalAlerts,
  ALERT_WINDOW_MS,
} from "@/platform/observability/external-failure";
import {
  ALERTING_REASONS,
  TRANSIENT_REASONS,
  type ExternalFailureReason,
} from "@/platform/errors/external-service";
import { aiErrorKind, anthropicFailureReason } from "@/platform/ai/provider";
import { internalError } from "@/platform/errors";
import {
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  retryDelayMs,
} from "@/lib/fetchWithTimeout";
import {
  initObservability,
  resetObservability,
  getObservability,
} from "@/platform/observability";

const alert = raiseAlert as jest.MockedFunction<typeof raiseAlert>;

beforeEach(() => {
  alert.mockReset();
  resetExternalAlerts();
});

describe("the classification table (audit D-8)", () => {
  it.each<[number, string, ExternalFailureReason]>([
    [401, "", "credential"],
    [
      403,
      '{"error":{"status":"PERMISSION_DENIED","message":"API key not valid"}}',
      "credential",
    ],
    [403, '{"error":{"message":"Quota exceeded for quota metric"}}', "quota"],
    [404, "", "rejected"],
    [408, "", "timeout"],
    [429, "", "rate_limited"],
    [
      429,
      '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}',
      "quota",
    ],
    // L-2: a per-minute limit is throttling, even when Google calls it a quota.
    [
      429,
      "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute'",
      "rate_limited",
    ],
    [403, '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}', "rate_limited"],
    [
      429,
      '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"reason":"RATE_LIMIT_EXCEEDED"}]}}',
      "rate_limited",
    ],
    [403, '{"error":{"errors":[{"reason":"dailyLimitExceeded"}]}}', "quota"],
    // L-3: Google's invalid or expired key is a 400.
    [
      400,
      '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}',
      "credential",
    ],
    [
      400,
      '{"error":{"message":"API key expired. Please renew the API key."}}',
      "credential",
    ],
    [500, "", "unavailable"],
    [502, "", "unavailable"],
    [503, "", "overloaded"],
    [529, "", "overloaded"],
    [400, "", "rejected"],
    [413, "", "rejected"],
  ])("HTTP %i %s → %s", (status, body, reason) => {
    expect(classifyHttpFailure(status, { body })).toBe(reason);
  });

  it("the AI provider: 404 is a retired model, an exhausted credit balance is quota", () => {
    expect(anthropicFailureReason(404, '{"error":{"type":"not_found_error"}}')).toBe(
      "model_retired"
    );
    expect(
      anthropicFailureReason(400, "Your credit balance is too low to access the API")
    ).toBe("quota");
    expect(anthropicFailureReason(400, "max_tokens: field required")).toBe("rejected");
  });

  it("the AI provider: 429 and 529 are transient (the breaker counts them); 401, 403, 404 are not", () => {
    for (const s of [429, 529, 500, 503]) {
      expect(aiErrorKind(anthropicFailureReason(s))).toBe("transient");
    }
    for (const s of [400, 401, 403, 404]) {
      expect(aiErrorKind(anthropicFailureReason(s))).toBe("permanent");
    }
  });

  it("transient and alerting reasons do not overlap", () => {
    for (const r of ALERTING_REASONS) expect(TRANSIENT_REASONS.has(r)).toBe(false);
  });

  it("a failure's text is read for classifying, bounded, and never throws", async () => {
    expect(await readFailureText({})).toBe("");
    expect(
      await readFailureText({
        text: async () => {
          throw new Error("x");
        },
      })
    ).toBe("");
    expect((await readFailureText({ text: async () => "a".repeat(5000) })).length).toBe(
      2000
    );
  });
});

describe("externalFailure records every failure (audit D-5)", () => {
  afterEach(() => resetObservability());

  it.each([...ALERTING_REASONS])("alerts on %s", (reason) => {
    const err = externalFailure("google-tts", reason, "Google TTS API error: 403", {
      status: 403,
    });
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toMatchObject({
      name: `external.${reason}`,
      tags: expect.objectContaining({ service: "google-tts", reason }),
    });
  });

  it("does not alert on a transient failure, but counts it", async () => {
    initObservability({ environment: "test", version: "t" });
    externalFailure("acrcloud", "overloaded", "ACRCloud HTTP error: 503", {
      status: 503,
    });
    expect(alert).not.toHaveBeenCalled();
    const recorded = await getObservability().metrics.query({ name: "external.failure" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].tags).toEqual(
      expect.objectContaining({
        service: "acrcloud",
        reason: "overloaded",
        status: "503",
      })
    );
  });

  it("alerts once per cause per window, then with the count of failures in between (L-1)", () => {
    const t0 = 1_000_000;
    const fail = (now: number) =>
      reportExternalFailure(
        new ExternalServiceError("google-tts", "credential", "Google TTS API error: 403"),
        now
      );
    fail(t0);
    fail(t0 + 1_000);
    fail(t0 + 2_000);
    expect(alert).toHaveBeenCalledTimes(1);
    // Another cause is its own window.
    reportExternalFailure(
      new ExternalServiceError("acrcloud", "credential", "3001"),
      t0 + 3_000
    );
    expect(alert).toHaveBeenCalledTimes(2);
    fail(t0 + ALERT_WINDOW_MS + 1);
    expect(alert).toHaveBeenCalledTimes(3);
    expect(alert.mock.calls[2][0]).toMatchObject({ count: 3 });
    expect(alert.mock.calls[2][0].message).toContain("3 failures since the last alert");
  });

  it("is recognised across bundle copies (by name and shape)", () => {
    const copy = Object.assign(new Error("x"), {
      name: "ExternalServiceError",
      service: "s",
      reason: "quota",
    });
    expect(isExternalServiceError(copy)).toBe(true);
    expect(isExternalServiceError(new Error("Google TTS API error: 403"))).toBe(false);
  });
});

describe("a route answers an external failure with service.unavailable (audit D-4/D-5)", () => {
  it.each<ExternalFailureReason>(["credential", "quota", "overloaded", "rate_limited"])(
    "%s → 503 service.unavailable naming the service, no provider text",
    async (reason) => {
      const res = internalError(
        new ExternalServiceError(
          "google-stt",
          reason,
          "Google STT API error: 403 key=AIza…"
        )
      );
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe("service.unavailable");
      expect(body.params).toEqual({ service: "google-stt" });
      expect(JSON.stringify(body)).not.toContain("AIza");
    }
  );

  it("a request the provider refused as malformed stays internal.error (it is the platform's)", async () => {
    const res = internalError(new ExternalServiceError("acrcloud", "rejected", "2004"));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("internal.error");
  });
});

describe("retry waits (audit D-8)", () => {
  it("jitters each exponential step within [step/2, step]", () => {
    expect(retryDelayMs(1, null, () => 0)).toBe(250);
    expect(retryDelayMs(1, null, () => 1)).toBe(500);
    expect(retryDelayMs(2, null, () => 0)).toBe(500);
    expect(retryDelayMs(2, null, () => 1)).toBe(1000);
  });

  it("honours Retry-After, with bounded jitter", () => {
    expect(retryDelayMs(1, 3000, () => 0)).toBe(3000);
    expect(retryDelayMs(1, 3000, () => 1)).toBe(3250);
    expect(retryDelayMs(1, 100, () => 1)).toBe(110);
  });

  it("does not wait for a Retry-After beyond the bound", () => {
    expect(retryDelayMs(1, MAX_RETRY_AFTER_MS + 1)).toBeNull();
    expect(retryDelayMs(1, MAX_RETRY_AFTER_MS, () => 0)).toBe(MAX_RETRY_AFTER_MS);
  });

  it("reads delta-seconds and HTTP dates; refuses junk", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("1.5")).toBe(1500);
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(parseRetryAfter("Thu, 29 Oct 2026 12:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("Thu, 29 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});
