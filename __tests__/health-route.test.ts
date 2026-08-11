/**
 * @jest-environment node
 */
/**
 * __tests__/health-route.test.ts
 *
 * TASK-057: the endpoint reported `status: "ok"` without running a probe.
 *
 * The observability module is mocked rather than initialised, so these arms test the route's
 * own decisions — fail-closed, status mapping, detail suppression — without depending on a
 * metrics sink or an error reporter reaching a network.
 */

import type { HealthReport } from "@/platform/observability";

const mockCheck = jest.fn();
const mockCaptureError = jest.fn();
let mockState: unknown = null;

jest.mock("@/platform/observability", () => ({
  tryGetObservability: () => mockState,
}));

import { GET } from "@/app/api/health/route";

function stateWith(report: HealthReport) {
  mockCheck.mockResolvedValue(report);
  return {
    health: { check: mockCheck },
    errors: { captureError: mockCaptureError },
  };
}

function report(
  status: HealthReport["status"],
  checks: HealthReport["checks"]
): HealthReport {
  return {
    status,
    checks,
    timestamp: "2026-08-04T00:00:00.000Z",
    version: "1.6.0",
  };
}

beforeEach(() => {
  mockState = null;
  mockCheck.mockReset();
  mockCaptureError.mockReset();
});

describe("GET /api/health — fail closed", () => {
  it("returns 503 when observability was never initialized", async () => {
    // "We cannot know" is not "healthy". Reporting ok here is the defect being fixed.
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("unhealthy");
    expect(body.probeCount).toBe(0);
  });

  it("carries a requestId even on the fail-closed path", async () => {
    const body = await (await GET()).json();
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
  });
});

describe("GET /api/health — status mapping", () => {
  it("returns 200 and the aggregate when every probe is healthy", async () => {
    mockState = stateWith(
      report("healthy", [
        { name: "song-id", status: "healthy", checkedAt: "2026-08-04T00:00:00.000Z" },
      ])
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
    expect(body.probeCount).toBe(1);
    expect(body.checks[0].name).toBe("song-id");
  });

  it("returns 200 for degraded — the service is still serving", async () => {
    mockState = stateWith(
      report("degraded", [
        { name: "cache", status: "degraded", detail: "slow", checkedAt: "t" },
      ])
    );
    expect((await GET()).status).toBe(200);
  });

  it("returns 503 for unhealthy — take it out of rotation", async () => {
    mockState = stateWith(
      report("unhealthy", [
        { name: "supabase", status: "unhealthy", detail: "401", checkedAt: "t" },
      ])
    );
    expect((await GET()).status).toBe(503);
  });

  it("actually runs the probes", async () => {
    // The whole defect was that it did not.
    mockState = stateWith(report("healthy", []));
    await GET();
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/health — OWASP A05, detail suppression", () => {
  it("never returns probe detail to an unauthenticated caller", async () => {
    mockState = stateWith(
      report("unhealthy", [
        {
          name: "supabase",
          status: "unhealthy",
          detail: "Supabase returned 401 for project xyz",
          checkedAt: "t",
        },
      ])
    );
    const body = await (await GET()).json();
    // Neither the credential hint nor the project ref may appear anywhere in the payload.
    expect(JSON.stringify(body)).not.toContain("401");
    expect(JSON.stringify(body)).not.toContain("xyz");
    expect(body.checks[0]).toEqual({
      name: "supabase",
      status: "unhealthy",
      checkedAt: "t",
    });
  });

  it("says where the detail went rather than leaving the caller guessing", async () => {
    mockState = stateWith(
      report("unhealthy", [{ name: "supabase", status: "unhealthy", checkedAt: "t" }])
    );
    const body = await (await GET()).json();
    expect(body.detail).toMatch(/error reporter/i);
    expect(body.detail).toMatch(/requestId/);
  });

  it("omits the notice entirely when everything is healthy", async () => {
    mockState = stateWith(
      report("healthy", [{ name: "song-id", status: "healthy", checkedAt: "t" }])
    );
    expect(await (await GET()).json()).not.toHaveProperty("detail");
  });
});

describe("GET /api/health — detail reaches the error reporter", () => {
  it("reports an unhealthy probe through the configured reporter, not Sentry directly", async () => {
    mockState = stateWith(
      report("unhealthy", [
        {
          name: "supabase",
          status: "unhealthy",
          detail: "connection refused",
          checkedAt: "t",
        },
      ])
    );
    await GET();
    expect(mockCaptureError).toHaveBeenCalledTimes(1);
    const [err, ctx] = mockCaptureError.mock.calls[0];
    expect(err.message).toContain("supabase");
    expect(err.message).toContain("connection refused");
    expect(ctx.tags.probe).toBe("supabase");
    expect(ctx.extra.requestId).toBeDefined();
  });

  it("does not report a degraded probe — it is not actionable enough to page anyone", async () => {
    mockState = stateWith(
      report("degraded", [{ name: "cache", status: "degraded", checkedAt: "t" }])
    );
    await GET();
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it("reports each unhealthy probe separately", async () => {
    mockState = stateWith(
      report("unhealthy", [
        { name: "a", status: "unhealthy", checkedAt: "t" },
        { name: "b", status: "unhealthy", checkedAt: "t" },
        { name: "c", status: "healthy", checkedAt: "t" },
      ])
    );
    await GET();
    expect(mockCaptureError).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/health — arms carried from the superseded health.test.ts", () => {
  // That file asserted status === "ok" and a hardcoded service string — it locked in the
  // defect and passed for months while the endpoint lied. Its one arm worth keeping is the
  // A05 guard, carried here rather than silently dropped with the file.
  it("does NOT expose API key presence", async () => {
    mockState = stateWith(
      report("healthy", [{ name: "song-id", status: "healthy", checkedAt: "t" }])
    );
    const body = await (await GET()).json();
    expect(body.apis).toBeUndefined();
    expect(body.anthropic).toBeUndefined();
    expect(body.google).toBeUndefined();
  });

  it("still returns a parseable timestamp", async () => {
    mockState = stateWith(report("healthy", []));
    const body = await (await GET()).json();
    expect(body.timestamp).toBeDefined();
    expect(() => new Date(body.timestamp)).not.toThrow();
  });
});

describe("GET /api/health — zero probes is visible", () => {
  it("reports healthy but carries probeCount 0 so the emptiness is not hidden", async () => {
    // worstStatus of an empty list is healthy by definition. That is the same lie in a new
    // place unless the caller can see there was nothing to check.
    mockState = stateWith(report("healthy", []));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
    expect(body.probeCount).toBe(0);
    expect(body.checks).toEqual([]);
  });
});
