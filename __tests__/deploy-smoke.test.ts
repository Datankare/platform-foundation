/**
 * scripts/deploy-smoke.mjs (ADR-050 D5/D6, TASK-102/105) — run as the deploy workflow runs it,
 * against a local HTTP server standing in for a deployment. Proves it passes a healthy
 * deployment and fails, naming the step, on each way a deployment can be wrong.
 */
import { execFile, type ExecFileException } from "child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import { join } from "path";

const SCRIPT = join(process.cwd(), "scripts/deploy-smoke.mjs");

interface Deployment {
  commit: string | null;
  healthStatus: number;
  anonymous: { status: number; body: unknown };
  guestToken: string | null;
  translations: unknown;
}

const healthy = (): Deployment => ({
  commit: "e3c3fe4a1b2c",
  healthStatus: 200,
  anonymous: {
    status: 401,
    body: { code: "auth.required", message: "Sign in to continue." },
  },
  guestToken: "guest.payload.sig",
  translations: [{ language: "French", text: "Bonjour" }],
});

let deployment = healthy();
let translateAuth: string | undefined;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const d = deployment;
  if (req.method === "GET" && req.url === "/api/health") {
    return send(res, d.healthStatus, { status: "healthy", commit: d.commit });
  }
  if (req.method === "GET" && req.url === "/api/features") {
    return send(res, 200, { features: { sso_google: { available: true } } });
  }
  if (req.method === "POST" && req.url === "/api/auth/guest") {
    return send(res, 200, { success: true, token: d.guestToken });
  }
  if (req.method === "POST" && req.url === "/api/process") {
    req.resume();
    if (!req.headers.authorization)
      return send(res, d.anonymous.status, d.anonymous.body);
    translateAuth = req.headers.authorization;
    return send(res, 200, { translations: d.translations });
  }
  send(res, 404, { code: "not_found" });
});

let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  deployment = healthy();
  translateAuth = undefined;
});

function smoke(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      {
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH ?? "",
          SMOKE_WAIT_SECONDS: "0",
          ...env,
        } as NodeJS.ProcessEnv,
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

describe("deploy smoke (TASK-102)", () => {
  it("passes a healthy deployment, on the expected commit, and translates as a guest", async () => {
    const r = await smoke({
      SMOKE_BASE_URL: base,
      SMOKE_EXPECTED_COMMIT: "e3c3fe4a1b2c3d4e5f60718293a4b5c6d7e8f901",
    });
    expect(r.out).toContain("✓ health 200 (healthy), commit e3c3fe4a1b2c");
    expect(r.out).toContain("✓ features: sso_google");
    expect(r.out).toContain("✓ anonymous request refused (auth.required)");
    expect(r.out).toContain("✓ translate: 1 translation(s)");
    expect(r.out).toContain("✓ smoke passed");
    expect(r.code).toBe(0);
    expect(translateAuth).toBe("Bearer guest.payload.sig");
  });

  it("fails when the deployment runs a different commit (D6: the wrong branch is live)", async () => {
    deployment.commit = "1234567890ab";
    const r = await smoke({ SMOKE_BASE_URL: base, SMOKE_EXPECTED_COMMIT: "e3c3fe4" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("deployed commit 1234567890ab is not e3c3fe4");
  });

  it("fails when health is not 200 (e.g. a durable store refused to boot)", async () => {
    deployment.healthStatus = 503;
    const r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ health: 503");
  });

  it("fails when an anonymous request is let through or refused without a code", async () => {
    deployment.anonymous = { status: 401, body: { error: "Authentication required" } };
    let r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("refused: expected 401 with an error code, got 401");

    deployment.anonymous = { status: 200, body: { translations: [] } };
    r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("got 200");
  });

  it("fails when no signed guest token is issued (e.g. mock auth deployed)", async () => {
    deployment.guestToken = "mock-guest-token";
    const r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("guest: 200, no signed guest token");
  });

  it("fails on an empty translation — a 200 is not a result", async () => {
    deployment.translations = [{ language: "French", text: "  " }];
    const r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("translate: 200, no translation");
  });

  it("refuses bad settings before calling anything (exit 2)", async () => {
    for (const env of [
      {},
      { SMOKE_BASE_URL: "http://playform.example.com" },
      { SMOKE_BASE_URL: `${base}/api` },
      { SMOKE_BASE_URL: base, SMOKE_EXPECTED_COMMIT: "main" },
      { SMOKE_BASE_URL: base, SMOKE_TRANSLATE_PATH: "process" },
    ]) {
      const r = await smoke(env as Record<string, string>);
      expect({ env, code: r.code }).toEqual({ env, code: 2 });
      expect(r.out).toContain("✗ settings:");
    }
  });
});
