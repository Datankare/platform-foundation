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
  liveStatus: number;
  healthStatus: number;
  readiness: {
    status: string;
    ready: boolean;
    boot: string;
    checks: unknown[];
    draining?: boolean;
  };
  anonymous: { status: number; body: unknown };
  guestToken: string | null;
  translations: unknown;
}

const healthy = (): Deployment => ({
  commit: "e3c3fe4a1b2c",
  liveStatus: 200,
  healthStatus: 200,
  readiness: {
    status: "ready",
    ready: true,
    boot: "completed",
    checks: [{ name: "database", status: "healthy", required: true }],
  },
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
  if (req.method === "GET" && req.url === "/api/health/live") {
    return send(res, d.liveStatus, { status: "live", commit: d.commit });
  }
  if (req.method === "GET" && req.url === "/api/health/ready") {
    return send(res, d.healthStatus, { ...d.readiness, commit: d.commit });
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
    expect(r.out).toContain("✓ live 200");
    expect(r.out).toContain("✓ ready 200 (ready), commit e3c3fe4a1b2c");
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

  it("fails when the instance is not ready, naming what is down (ADR-056 D4)", async () => {
    deployment.healthStatus = 503;
    deployment.readiness = {
      status: "unready",
      ready: false,
      boot: "completed",
      checks: [{ name: "database", status: "unhealthy", required: true }],
    };
    const r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "✗ ready: 503 (unready, boot completed) — unhealthy: database"
    );
  });

  it("fails when boot did not complete, even if the dependencies answer", async () => {
    deployment.healthStatus = 503;
    deployment.readiness = {
      status: "unready",
      ready: false,
      boot: "failed",
      checks: [],
    };
    const r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ ready: 503 (unready, boot failed)");
  });

  it("passes a degraded instance (an optional dependency down) and says so", async () => {
    deployment.readiness = {
      status: "degraded",
      ready: true,
      boot: "completed",
      checks: [{ name: "realtime", status: "unhealthy", required: false }],
    };
    const r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.out).toContain("✓ ready 200 (degraded)");
    expect(r.code).toBe(0);
  });

  it("refuses a 200 that does not say ready (an old or broken readiness answer)", async () => {
    deployment.readiness = {
      status: "healthy",
      ready: false,
      boot: "completed",
      checks: [],
    };
    const r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ ready: 200");
  });

  it("fails when the process does not answer at all", async () => {
    deployment.liveStatus = 502;
    const r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ live: 502");
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

  it("fails when no signed guest token is issued (e.g. a build that predates ADR-050 D4)", async () => {
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

  it("reads the translated text from the field the app names (SMOKE_TRANSLATION_FIELD)", async () => {
    deployment.translations = [{ language: "French", translated: "Bonjour" }];
    let r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("translate: 200, no translation");

    r = await smoke({ SMOKE_BASE_URL: base, SMOKE_TRANSLATION_FIELD: "translated" });
    expect(r.out).toContain("✓ translate: 1 translation(s)");
    expect(r.code).toBe(0);
  });

  it("skips only the translation with SMOKE_SKIP_TRANSLATE=1, and says so (CI without AI credentials)", async () => {
    deployment.translations = [];
    const r = await smoke({ SMOKE_BASE_URL: base, SMOKE_SKIP_TRANSLATE: "1" });
    expect(r.out).toContain("✓ guest token issued (signed)");
    expect(r.out).toContain("– translate: skipped (SMOKE_SKIP_TRANSLATE=1");
    expect(r.out).toContain("✓ smoke passed (translate skipped)");
    expect(r.code).toBe(0);
    expect(translateAuth).toBeUndefined();

    // Everything before it still has to pass.
    deployment.guestToken = null;
    const failed = await smoke({ SMOKE_BASE_URL: base, SMOKE_SKIP_TRANSLATE: "1" });
    expect(failed.code).toBe(1);
  });

  it("names a draining instance (stopping — ADR-055 D5)", async () => {
    deployment.healthStatus = 503;
    deployment.readiness = {
      status: "unready",
      ready: false,
      boot: "completed",
      checks: [],
      draining: true,
    };
    const r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ ready: 503 (unready, boot completed, draining)");
  });

  it("refuses bad settings before calling anything (exit 2)", async () => {
    for (const env of [
      {},
      { SMOKE_BASE_URL: "http://playform.example.com" },
      { SMOKE_BASE_URL: `${base}/api` },
      { SMOKE_BASE_URL: base, SMOKE_EXPECTED_COMMIT: "main" },
      { SMOKE_BASE_URL: base, SMOKE_TRANSLATE_PATH: "process" },
      { SMOKE_BASE_URL: base, SMOKE_TRANSLATION_FIELD: "a.b" },
      { SMOKE_BASE_URL: base, SMOKE_SKIP_TRANSLATE: "true" },
    ]) {
      const r = await smoke(env as Record<string, string>);
      expect({ env, code: r.code }).toEqual({ env, code: 2 });
      expect(r.out).toContain("✗ settings:");
    }
  });
});
