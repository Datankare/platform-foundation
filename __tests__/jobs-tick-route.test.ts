/**
 * @jest-environment node
 */
/**
 * /api/internal/jobs/tick (ADR-056 D2): only the host's scheduler, with CRON_SECRET, makes the
 * runner work. Hostile cases: no secret configured, a short one, a missing header, a forged
 * secret, a near miss (a prefix, a suffix, another scheme, extra whitespace, a second header
 * value), and the right secret through GET (Vercel Cron) and POST (the CLI worker).
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-test",
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/internal/jobs/tick/route";
import {
  InMemoryJobStore,
  registerJob,
  resetJobRegistry,
  resetJobStore,
  setJobStore,
  tickHeaderMatches,
} from "@/platform/jobs";
import * as runner from "@/platform/jobs/runner";

const SECRET = "s3cr3t-".repeat(6); // 42 characters
const saved = process.env.CRON_SECRET;

function req(method: "GET" | "POST", authorization?: string): NextRequest {
  return new NextRequest("http://localhost/api/internal/jobs/tick", {
    method,
    headers: authorization === undefined ? {} : { authorization },
  });
}

let ran: string[];
let store: InMemoryJobStore;
beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  ran = [];
  store = new InMemoryJobStore({ activeTenants: async () => [] });
  setJobStore(store);
});
afterEach(() => {
  if (saved === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved;
  resetJobRegistry();
  resetJobStore();
  jest.restoreAllMocks();
});

describe("the tick's verifier", () => {
  it.each([
    ["is not set", undefined],
    ["is shorter than 32 characters", "short-secret"],
  ])("refuses every tick when CRON_SECRET %s (503)", async (_l, value) => {
    if (value === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = value;
    const spy = jest.spyOn(runner, "runDue");
    for (const r of [req("GET", `Bearer ${value ?? ""}`), req("POST")]) {
      const res = await (r.method === "GET" ? GET(r) : POST(r));
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("service.unavailable");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a request without credentials (401 auth.required)", async () => {
    const res = await GET(req("GET"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth.required");
  });

  it.each([
    ["a forged secret", "Bearer " + "x".repeat(42)],
    ["the secret without its scheme", SECRET],
    ["another scheme", `Basic ${SECRET}`],
    ["a lower-case scheme", `bearer ${SECRET}`],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, 41)}`],
    ["the secret with a suffix", `Bearer ${SECRET}x`],
    ["extra whitespace", `Bearer  ${SECRET}`],
    ["two values", `Bearer ${SECRET}, Bearer ${SECRET}`],
    ["an empty bearer", "Bearer "],
  ])("refuses %s (401 auth.token_invalid) and runs nothing", async (_l, header) => {
    const spy = jest.spyOn(runner, "runDue");
    for (const method of ["GET", "POST"] as const) {
      const r = req(method, header);
      const res = await (method === "GET" ? GET(r) : POST(r));
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe("auth.token_invalid");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("matches only the exact header", () => {
    expect(tickHeaderMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(tickHeaderMatches(`Bearer ${SECRET}`, `${SECRET}x`)).toBe(false);
    expect(tickHeaderMatches("", SECRET)).toBe(false);
  });
});

describe("an admitted tick", () => {
  it.each(["GET", "POST"] as const)(
    "runs due work through %s and reports it",
    async (method) => {
      registerJob(
        "test.tick",
        async () => {
          ran.push("x");
        },
        { description: "A test job." }
      );
      await store.enqueue({
        tenantId: null,
        kind: "test.tick",
        idempotencyKey: "1",
        maxAttempts: 1,
        source: "enqueue",
      });
      const r = req(method, `Bearer ${SECRET}`);
      const res = await (method === "GET" ? GET(r) : POST(r));
      expect(res.status).toBe(200);
      const body = await res.json();
      // A full tick: the due schedule slots (the platform duties here) and the queued job.
      expect(body.result.claimed).toBeGreaterThanOrEqual(1);
      expect(body.result.scheduled.length).toBeGreaterThan(0);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(ran).toEqual(["x"]);
    }
  );

  it("answers a coded 500 with no internal detail when the runner fails", async () => {
    jest.spyOn(runner, "runDue").mockRejectedValue(new Error("pool: password=hunter2"));
    const res = await POST(req("POST", `Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).code).toBe("internal.error");
    expect(text).not.toContain("hunter2");
  });
});
