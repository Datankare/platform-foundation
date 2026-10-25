/**
 * scripts/jobs-worker.mjs (ADR-056 D2): the host-neutral tick, run as a container host runs it,
 * against a local HTTP server standing in for the app's tick route. Proves it sends the secret,
 * ticks again at once while work remains, stops for good on a refused secret, keeps going
 * through an outage, stops cleanly on SIGTERM, and refuses bad settings before calling.
 */
import { execFile, spawn, type ExecFileException } from "child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import { join } from "path";

const SCRIPT = join(process.cwd(), "scripts/jobs-worker.mjs");
const SECRET = "w".repeat(40);

let answers: { status: number; body: unknown; delayMs?: number }[] = [];
let calls: { method: string; url: string; auth: string | undefined }[] = [];
/** Ticks the fake app has answered (a delayed answer counts once it is sent). */
let answered = 0;

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  req.resume();
  calls.push({
    method: req.method ?? "",
    url: req.url ?? "",
    auth: req.headers.authorization,
  });
  const a = answers.length > 1 ? answers.shift()! : answers[0];
  const answer = () => {
    if (res.destroyed) return;
    answered += 1;
    res.writeHead(a.status, { "content-type": "application/json" });
    res.end(JSON.stringify(a.body));
  };
  if (a.delayMs) setTimeout(answer, a.delayMs).unref();
  else answer();
});

let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  calls = [];
  answers = [];
  answered = 0;
});

const ok = (stoppedBy: "idle" | "budget") => ({
  status: 200,
  body: {
    result: {
      scheduled: [{ kind: "a.b", enqueued: 1 }],
      claimed: 2,
      succeeded: 2,
      retried: 0,
      dead: 0,
      stoppedBy,
    },
  },
});

function worker(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      {
        env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
        timeout: 20_000,
      },
      (err: ExecFileException | null, stdout: string, stderr: string) =>
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          out: stdout + stderr,
        })
    );
  });
}

describe("jobs worker", () => {
  it("ticks once with the secret and reports it (JOBS_WORKER_ONCE)", async () => {
    answers = [ok("idle")];
    const r = await worker({
      JOBS_WORKER_URL: base,
      CRON_SECRET: SECRET,
      JOBS_WORKER_ONCE: "1",
    });
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      { method: "POST", url: "/api/internal/jobs/tick", auth: `Bearer ${SECRET}` },
    ]);
    expect(r.out).toContain("✓ tick: scheduled 1, claimed 2, succeeded 2");
  });

  it("stops for good when the app refuses the secret (exit 2)", async () => {
    answers = [{ status: 401, body: { code: "auth.token_invalid" } }];
    const r = await worker({ JOBS_WORKER_URL: base, CRON_SECRET: SECRET });
    expect(r.code).toBe(2);
    expect(r.out).toContain("✗ tick 401 auth.token_invalid");
    expect(calls).toHaveLength(1);
  });

  it("fails one tick on an outage (exit 1 with JOBS_WORKER_ONCE)", async () => {
    answers = [{ status: 503, body: { code: "service.unavailable" } }];
    const r = await worker({
      JOBS_WORKER_URL: base,
      CRON_SECRET: SECRET,
      JOBS_WORKER_ONCE: "1",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ tick 503 service.unavailable");
  });

  it("ticks again at once while work remains, waits otherwise, and stops on SIGTERM", async () => {
    answers = [ok("budget"), ok("budget"), ok("idle")];
    const env = {
      PATH: process.env.PATH ?? "",
      JOBS_WORKER_URL: base,
      CRON_SECRET: SECRET,
      JOBS_WORKER_INTERVAL_SECONDS: "3600",
    } as unknown as NodeJS.ProcessEnv;
    const child = spawn(process.execPath, [SCRIPT], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    for (let i = 0; i < 100 && calls.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(calls).toHaveLength(3);
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", (c) => resolve(c));
      child.kill("SIGTERM");
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(3);
    expect(out).toContain("stopped by idle");
  });

  // Review finding 1: a worker stopped while a tick was in flight waited for it — up to the
  // tick's 45 s budget, past Docker's 10 s grace. It stops at once now; the app finishes the tick.
  it("stops at once on SIGTERM while a tick is in flight (exit 0)", async () => {
    answers = [{ ...ok("idle"), delayMs: 30_000 }];
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        PATH: process.env.PATH ?? "",
        JOBS_WORKER_URL: base,
        CRON_SECRET: SECRET,
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    for (let i = 0; i < 100 && calls.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(calls).toHaveLength(1);
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", (c) => resolve(c));
      child.kill("SIGTERM");
    });
    expect(code).toBe(0);
    // It exited with the tick still unanswered — it did not wait for it (asserted as work, not
    // as wall-clock time: review 10 L11).
    expect(answered).toBe(0);
    expect(out).toContain("stopped — the tick in flight is the app's to finish");
  });

  it("refuses bad settings before calling anything (exit 2)", async () => {
    for (const env of [
      {},
      { JOBS_WORKER_URL: base },
      { JOBS_WORKER_URL: base, CRON_SECRET: "short" },
      { JOBS_WORKER_URL: "http://app.example.com", CRON_SECRET: SECRET },
      { JOBS_WORKER_URL: `${base}/api`, CRON_SECRET: SECRET },
      { JOBS_WORKER_URL: base, CRON_SECRET: SECRET, JOBS_WORKER_INTERVAL_SECONDS: "1" },
      { JOBS_WORKER_URL: base, CRON_SECRET: `${SECRET} space` },
    ]) {
      const r = await worker(env as Record<string, string>);
      expect({ env, code: r.code }).toEqual({ env, code: 2 });
      expect(r.out).toContain("✗ settings:");
    }
    expect(calls).toEqual([]);
  });
});
