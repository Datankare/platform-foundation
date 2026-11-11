/**
 * __tests__/health-watch.test.ts — scripts/health-watch.mjs, the outside poll of a deployment's
 * health (TASK-204, N-15; R-79)
 *
 * @guard a stopped job tick (or a down deployment) that nobody is told about
 *
 * The script runs for real against a local /api/health. Hostile: unreachable, an unexpected
 * status, an answer without checks, the watched probe missing, and detail never printed.
 */
import { spawn } from "child_process";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(__dirname, "..", "scripts/health-watch.mjs");

function serve(status: number, body: unknown): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url !== "/api/health") return res.writeHead(404).end("{}");
    res
      .writeHead(status, { "content-type": "application/json" })
      .end(typeof body === "string" ? body : JSON.stringify(body));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

async function watch(base: string, env: Record<string, string> = {}) {
  const out = join(mkdtempSync(join(tmpdir(), "hw-")), "out");
  writeFileSync(out, "");
  const r = await new Promise<{ code: number | null; log: string }>((resolve) => {
    const child = spawn("node", [SCRIPT, base], {
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_OUTPUT: out,
        ...env,
      } as unknown as NodeJS.ProcessEnv,
    });
    let log = "";
    child.stdout.on("data", (d: Buffer) => (log += d));
    child.on("close", (code) => resolve({ code, log }));
  });
  return { ...r, output: readFileSync(out, "utf8") };
}

async function against(status: number, body: unknown, env: Record<string, string> = {}) {
  const s = await serve(status, body);
  try {
    return await watch(`http://127.0.0.1:${(s.address() as AddressInfo).port}`, env);
  } finally {
    s.close();
  }
}

const healthy = (extra: { name: string; status: string }[] = []) => ({
  status: extra.some((c) => c.status !== "healthy") ? "degraded" : "healthy",
  checks: [
    { name: "job-schedules", status: "healthy" },
    { name: "database", status: "healthy" },
    ...extra,
  ],
});

describe("scripts/health-watch.mjs", () => {
  it("ok when the watched probe is healthy; another degraded probe is only a notice", async () => {
    const r = await against(200, healthy([{ name: "song-id", status: "degraded" }]));
    expect(r.code).toBe(0);
    expect(r.output).toBe("state=ok\n");
    expect(r.log).toContain("::notice::");
    expect(r.log).toContain("song-id is degraded");
  });

  it("[self-test] a stopped job tick is a problem, named", async () => {
    const r = await against(200, {
      status: "degraded",
      checks: [{ name: "job-schedules", status: "degraded" }],
      detail: "SECRET-DETAIL-MUST-NOT-PRINT",
    });
    expect(r.output).toContain("state=problem\n");
    expect(r.output).toContain(
      "reason=job-schedules is degraded: the timed duties have stopped"
    );
    expect(r.log + r.output).not.toContain("SECRET-DETAIL");
  });

  it("[hostile] unhealthy (503), another status, no checks, or the probe missing: a problem", async () => {
    expect(
      (
        await against(503, {
          status: "unhealthy",
          checks: [{ name: "database", status: "unhealthy" }],
        })
      ).output
    ).toContain("reason=the deployment is unhealthy (database)");
    expect((await against(500, "oops")).output).toContain(
      "reason=/api/health answered HTTP 500"
    );
    expect((await against(200, "not json")).output).toContain("without its checks");
    expect(
      (
        await against(200, {
          status: "healthy",
          checks: [{ name: "database", status: "healthy" }],
        })
      ).output
    ).toContain("reason=job-schedules: not reported");
  });

  it("[hostile:store-down] an unreachable deployment is a problem", async () => {
    const r = await watch("http://127.0.0.1:9");
    expect(r.output).toContain("reason=the deployment could not be reached");
  });

  it("watches what WATCH_CHECKS names; refuses a URL with a path (exit 2)", async () => {
    const r = await against(200, healthy([{ name: "cache", status: "degraded" }]), {
      WATCH_CHECKS: "job-schedules,cache",
    });
    expect(r.output).toContain("reason=cache is degraded");
    expect((await watch("http://x.test/api/health")).code).toBe(2);
  });
});
