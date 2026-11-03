/**
 * TASK-197 (audit D-2, D-3, D-7): the readiness probes for paid dependencies.
 *
 * @not-guard: behaviour tests of the paid probes; reads the two health routes to pin one call
 *
 * LLMProviderHealthProbe's empty-body POST answered 400 for a retired model or an exhausted
 * balance — and was reported healthy. These probes make the provider's cheapest real call with
 * the deployed credential: success is healthy; a refused key, an exhausted quota, a retired model
 * or a refused request shape is unhealthy; throttling is degraded; nothing configured is healthy.
 */

import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { PaidApiProbe } from "@/platform/observability/paid-api-probe";
import {
  aiProbeRequest,
  createAIProviderReadinessProbe,
} from "@/platform/ai/readiness-probe";
import { MODEL_REGISTRY } from "@/platform/ai/types";
import { createRateLimitStoreProbe } from "@/platform/rate-limit/store-probe";
import { externalFailure } from "@/platform/observability/external-failure";
import type { RateLimiter } from "@/platform/rate-limit";

jest.mock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: jest.fn() }));
jest.mock("@/platform/observability/alert", () => ({ raiseAlert: jest.fn() }));
const mockFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;

const answer = (status: number, body: unknown = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

beforeEach(() => mockFetch.mockReset());

describe("PaidApiProbe — the answer's classification", () => {
  const probe = (res: () => Response, extra = {}) =>
    new PaidApiProbe({
      name: "p",
      calls: () => [{ label: "call", call: async () => res(), ...extra }],
    });

  it.each([
    [200, "healthy"],
    [401, "unhealthy"],
    [403, "unhealthy"],
    [400, "unhealthy"],
    [429, "degraded"],
    [529, "degraded"],
    [503, "degraded"],
    [500, "degraded"],
  ])("HTTP %i → %s", async (status, expected) => {
    expect((await probe(() => answer(status)).check()).status).toBe(expected);
  });

  it("a 404 on a model endpoint is a retired model: unhealthy, named", async () => {
    const r = await probe(() => answer(404), { notFound: "model_retired" }).check();
    expect(r.status).toBe("unhealthy");
    expect(r.detail).toContain("model_retired");
  });

  it("no answer at all is unhealthy", async () => {
    const r = await new PaidApiProbe({
      name: "p",
      calls: () => [
        {
          label: "call",
          call: async () => {
            throw new TypeError("fetch failed");
          },
        },
      ],
    }).check();
    expect(r.status).toBe("unhealthy");
  });

  it("nothing configured is healthy, and says so", async () => {
    const r = await new PaidApiProbe({ name: "p", calls: () => null }).check();
    expect(r.status).toBe("healthy");
    expect(r.detail).toContain("not configured");
  });
});

describe("the AI provider probe: the deployed key and every registry model (D-2/D-3)", () => {
  it("sends max_tokens 1 per distinct model, with the deployment's key and the entry's settings", async () => {
    mockFetch.mockResolvedValue(answer(200, { content: [] }));
    const r = await createAIProviderReadinessProbe({
      ANTHROPIC_API_KEY: "deployed-key",
    }).check();
    expect(r.status).toBe("healthy");
    const models = [...new Set(Object.values(MODEL_REGISTRY).map((m) => m.modelId))];
    expect(mockFetch).toHaveBeenCalledTimes(models.length);
    const sent = mockFetch.mock.calls.map(([, init]) => ({
      key: (init?.headers as Record<string, string>)["x-api-key"],
      body: JSON.parse(String(init?.body)),
    }));
    expect(sent.map((s) => s.key)).toEqual(models.map(() => "deployed-key"));
    expect(sent.map((s) => s.body.model).sort()).toEqual([...models].sort());
    for (const s of sent) expect(s.body.max_tokens).toBe(1);
    for (const config of Object.values(MODEL_REGISTRY)) {
      expect(aiProbeRequest(config)).toEqual(
        expect.objectContaining({
          model: config.modelId,
          max_tokens: 1,
          ...(config.thinking ? { thinking: config.thinking } : {}),
        })
      );
      expect("temperature" in aiProbeRequest(config)).toBe(config.acceptsTemperature);
    }
  });

  it("an exhausted credit balance (a 400) is unhealthy, not the old probe's 'healthy'", async () => {
    mockFetch.mockResolvedValue(
      answer(400, {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Your credit balance is too low",
        },
      })
    );
    const r = await createAIProviderReadinessProbe({ ANTHROPIC_API_KEY: "k" }).check();
    expect(r.status).toBe("unhealthy");
    expect(r.detail).toContain("quota");
  });

  it("a retired model (404) is unhealthy and named", async () => {
    mockFetch.mockResolvedValue(answer(404, { error: { type: "not_found_error" } }));
    const r = await createAIProviderReadinessProbe({ ANTHROPIC_API_KEY: "k" }).check();
    expect(r.status).toBe("unhealthy");
    expect(r.detail).toContain("model_retired");
  });

  it("no key is unhealthy without calling anyone; another AI provider is not probed", async () => {
    expect((await createAIProviderReadinessProbe({}).check()).status).toBe("unhealthy");
    expect(
      (await createAIProviderReadinessProbe({ AI_PROVIDER: "mock" }).check()).status
    ).toBe("healthy");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("is cached: two readiness checks make the billed calls once", async () => {
    mockFetch.mockResolvedValue(answer(200, {}));
    const probe = createAIProviderReadinessProbe({ ANTHROPIC_API_KEY: "k" });
    await probe.check();
    const calls = mockFetch.mock.calls.length;
    await probe.check();
    expect(mockFetch.mock.calls.length).toBe(calls);
  });
});

describe("the rate-limit store probe (D-2/D-7)", () => {
  const limiter = (peek: RateLimiter["peek"]): RateLimiter =>
    ({
      name: "redis",
      peek,
      check: jest.fn(),
      reset: jest.fn(),
    }) as unknown as RateLimiter;

  it("healthy when the store answers a read", async () => {
    const peek = jest.fn().mockResolvedValue({ allowed: true });
    const r = await createRateLimitStoreProbe(() => limiter(peek)).check();
    expect(r.status).toBe("healthy");
    expect(peek).toHaveBeenCalledTimes(1);
  });

  it("a rotated token (401) is unhealthy; a throttled store degraded", async () => {
    const refused = externalFailure("upstash", "credential", "Redis pipeline HTTP 401", {
      status: 401,
    });
    expect(
      (
        await createRateLimitStoreProbe(() =>
          limiter(async () => Promise.reject(refused))
        ).check()
      ).status
    ).toBe("unhealthy");
    const busy = externalFailure("upstash", "rate_limited", "429", { status: 429 });
    expect(
      (
        await createRateLimitStoreProbe(() =>
          limiter(async () => Promise.reject(busy))
        ).check()
      ).status
    ).toBe("degraded");
  });
});

describe("a paid probe's own budget (TASK-197 review round 1, M-1)", () => {
  const { CachedHealthProbe } = require("@/platform/observability/health");
  const { PAID_PROBE_CACHE } = require("@/platform/observability/paid-api-probe");

  function slowProbe() {
    let answer: (status: "healthy" | "unhealthy") => void = () => undefined;
    let budget: number | undefined;
    const probe = {
      name: "p",
      check: (timeoutMs?: number) => {
        budget = timeoutMs;
        return new Promise((resolve) => {
          answer = (status) => resolve({ name: "p", status, checkedAt: "t" });
        });
      },
    };
    return {
      probe,
      answer: (s: "healthy" | "unhealthy") => answer(s),
      budget: () => budget,
    };
  }

  it("answers within readiness's bound — pending, never a timeout read as unhealthy — while the call runs on its own budget", async () => {
    // On jest's fake clock (TASK-198, D-13): the time measured is the clock's, not the runner's.
    jest.useFakeTimers();
    try {
      const slow = slowProbe();
      const cached = new CachedHealthProbe(
        slow.probe,
        15 * 60_000,
        () => Date.now(),
        PAID_PROBE_CACHE
      );
      let answeredAt: number | undefined;
      const started = Date.now();
      const pending = cached.check(300);
      void pending.then(() => {
        answeredAt = Date.now() - started;
      });
      await jest.advanceTimersByTimeAsync(300);
      // Answered within readiness's own 300 ms of the clock, while the call still runs: at 50 ms
      // (the 300 ms bound less CachedHealthProbe's 250 ms margin).
      expect(answeredAt).toBe(50);
      const first = await pending;
      expect(first.status).toBe("degraded");
      expect(first.detail).toContain("pending");
      expect(slow.budget()).toBe(15_000);
      slow.answer("healthy");
      await jest.advanceTimersByTimeAsync(0);
      expect((await cached.check(300)).status).toBe("healthy");
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps a result that is not healthy only 60 s, a healthy one for the interval", async () => {
    let now = 0;
    let status: "healthy" | "unhealthy" = "unhealthy";
    let calls = 0;
    const probe = {
      name: "p",
      check: async () => {
        calls++;
        return { name: "p", status, checkedAt: "t" };
      },
    };
    const cached = new CachedHealthProbe(probe, 15 * 60_000, () => now, PAID_PROBE_CACHE);
    await cached.check(3_000);
    now = 59_000;
    await cached.check(3_000);
    expect(calls).toBe(1);
    now = 61_000;
    status = "healthy";
    expect((await cached.check(3_000)).status).toBe("healthy");
    expect(calls).toBe(2);
    now = 61_000 + 10 * 60_000;
    await cached.check(3_000);
    expect(calls).toBe(2);
  });
});

describe("a paid check frozen or hung (TASK-197 review round 2)", () => {
  const {
    CachedHealthProbe,
    settlePendingProbes,
  } = require("@/platform/observability/health");
  const { PAID_PROBE_CACHE } = require("@/platform/observability/paid-api-probe");

  function controlled() {
    const answers: ((s: "healthy" | "unhealthy") => void)[] = [];
    let calls = 0;
    const probe = {
      name: "p",
      check: () =>
        new Promise((resolve) => {
          calls++;
          answers.push((status) => resolve({ name: "p", status, checkedAt: "t" }));
        }),
    };
    return { probe, answers, calls: () => calls };
  }

  it("abandons a check in flight past twice its budget: answered degraded (round 3), never cached, a new check started", async () => {
    let now = 0;
    const c = controlled();
    const cached = new CachedHealthProbe(
      c.probe,
      15 * 60_000,
      () => now,
      PAID_PROBE_CACHE
    );
    expect((await cached.check(300)).status).toBe("degraded");
    now = 2 * PAID_PROBE_CACHE.budgetMs + 1;
    const abandoned = await cached.check(300);
    // Round 3 (N4): degraded, not unhealthy — no answer is not proof of failure.
    expect(abandoned.status).toBe("degraded");
    expect(abandoned.detail).toContain("did not finish");
    expect(c.calls()).toBe(2);
    // The abandoned check's late answer is not cached; the new one's is.
    c.answers[0]("unhealthy");
    c.answers[1]("healthy");
    await settlePendingProbes();
    expect((await cached.check(300)).status).toBe("healthy");
  });

  it("does not cache an answer that took longer than twice the budget (the function was frozen)", async () => {
    let now = 0;
    const c = controlled();
    const cached = new CachedHealthProbe(
      c.probe,
      15 * 60_000,
      () => now,
      PAID_PROBE_CACHE
    );
    await cached.check(300);
    now = 3 * PAID_PROBE_CACHE.budgetMs; // thawed long after
    c.answers[0]("unhealthy");
    await settlePendingProbes();
    expect(c.calls()).toBe(1);
    await cached.check(300);
    expect(c.calls()).toBe(2);
  });

  it("the routes keep the function alive for running checks (after), and it is harmless outside a request", () => {
    jest.isolateModules(() => {
      const after = jest.fn();
      jest.doMock("next/server", () => ({ ...jest.requireActual("next/server"), after }));
      const {
        keepAliveForProbes,
      } = require("@/platform/observability/keep-probes-alive");
      keepAliveForProbes();
      expect(after).toHaveBeenCalledTimes(1);
      jest.dontMock("next/server");
    });
    const { keepAliveForProbes } = require("@/platform/observability/keep-probes-alive");
    expect(() => keepAliveForProbes()).not.toThrow();
    for (const route of ["app/api/health/route.ts", "app/api/health/ready/route.ts"]) {
      expect({
        route,
        text: require("node:fs")
          .readFileSync(require("node:path").join(__dirname, "..", route), "utf8")
          .includes("keepAliveForProbes();"),
      }).toEqual({ route, text: true });
    }
  });
});

describe("a paid probe honours its budget and never takes an instance out (TASK-197 review round 3, N4)", () => {
  const {
    CachedHealthProbe,
    HealthRegistry,
  } = require("@/platform/observability/health");
  const { PAID_PROBE_CACHE } = require("@/platform/observability/paid-api-probe");

  it("an abandoned optional probe leaves the report degraded (200), never unhealthy (503)", async () => {
    let now = 0;
    const hung = { name: "paid", check: () => new Promise(() => undefined) };
    const cached = new CachedHealthProbe(hung, 15 * 60_000, () => now, PAID_PROBE_CACHE);
    const registry = new HealthRegistry();
    registry.register(cached, { required: false });
    await cached.check(300);
    now = 2 * PAID_PROBE_CACHE.budgetMs + 1;
    const report = await registry.check(300);
    expect(report.status).toBe("degraded");
  });
});
