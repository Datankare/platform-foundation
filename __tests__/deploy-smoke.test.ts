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
  /** What POST /api/auth/guest answers: its body, and the Set-Cookie line (null: none). */
  guestBody: Record<string, unknown>;
  guestCookie: string | null;
  /** What GET /api/auth/session answers for the guest's cookie. */
  sessionStatusBody: Record<string, unknown>;
  /** Whether a state-changing request without the session's token is refused. */
  forgeryRefused: boolean;
  translations: unknown;
  /** The session route's answer (step 6, TASK-181). */
  sessionStatus: number;
  dispatchStatus: number;
  sessionTranslations: unknown;
}

const SESSION_ID = "s".repeat(43);
const CSRF = "c".repeat(43);
/** What a browser sends for the guest's session on a state-changing request (ADR-057 D4). */
const BROWSER = (origin: string) => ({
  cookie: `pf_session=${SESSION_ID}`,
  origin,
  csrf: CSRF,
});
/** The credentials of a request as the stand-in saw them. */
const seen = (req: IncomingMessage) => ({
  cookie: req.headers.cookie,
  origin: req.headers.origin,
  csrf: req.headers["x-csrf-token"],
});

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
  guestBody: { success: true, guestId: "guest_1", expiresAt: 1_900_000_000 },
  guestCookie: `pf_session=${SESSION_ID}; Path=/; Max-Age=86400; HttpOnly; SameSite=lax`,
  sessionStatusBody: {
    authenticated: true,
    user: { userId: "guest_1", email: "", emailVerified: false, isGuest: true },
    csrfToken: CSRF,
  },
  forgeryRefused: true,
  translations: [{ language: "French", text: "Bonjour" }],
  sessionStatus: 200,
  dispatchStatus: 200,
  sessionTranslations: [{ code: "fr", translated: "Bonjour" }],
});

let dispatched: { auth?: unknown; body?: unknown } = {};
/** Every Authorization header the stand-in received: the smoke test must send none. */
let authorizationHeaders: string[] = [];

let deployment = healthy();
let translateAuth: ReturnType<typeof seen> | undefined;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The first `pendingCalls` readiness answers are `pendingReadiness` (a probe still pending). */
let readyCalls = 0;
let pendingCalls = 0;
let pendingReadiness: Record<string, unknown> = {};

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const d = deployment;
  if (req.headers.authorization) authorizationHeaders.push(req.headers.authorization);
  if (req.method === "GET" && req.url === "/api/health/live") {
    return send(res, d.liveStatus, { status: "live", commit: d.commit });
  }
  if (req.method === "GET" && req.url === "/api/health/ready") {
    readyCalls++;
    const readiness: object = readyCalls <= pendingCalls ? pendingReadiness : d.readiness;
    return send(res, d.healthStatus, { ...readiness, commit: d.commit });
  }
  if (req.method === "GET" && req.url === "/api/features") {
    return send(res, 200, { features: { sso_google: { available: true } } });
  }
  if (req.method === "POST" && req.url === "/api/auth/guest") {
    res.writeHead(200, {
      "content-type": "application/json",
      ...(d.guestCookie ? { "set-cookie": d.guestCookie } : {}),
    });
    return res.end(JSON.stringify(d.guestBody));
  }
  if (req.url === "/api/auth/session") {
    req.resume();
    if (req.method === "GET") return send(res, 200, d.sessionStatusBody);
    // The keep-alive: a state-changing request, refused without the session's token.
    return req.headers["x-csrf-token"] === CSRF || !d.forgeryRefused
      ? send(res, 200, d.sessionStatusBody)
      : send(res, 403, { code: "auth.csrf_failed" });
  }
  if (req.method === "POST" && req.url === "/api/process") {
    req.resume();
    if (!req.headers.cookie) return send(res, d.anonymous.status, d.anonymous.body);
    translateAuth = seen(req);
    return send(res, 200, { translations: d.translations });
  }
  if (req.method === "POST" && req.url === "/api/translate/session") {
    req.resume();
    return d.sessionStatus === 200
      ? send(res, 200, { sessionId: "s-1", version: 1, state: { translations: [] } })
      : send(res, d.sessionStatus, { code: "auth.required" });
  }
  if (req.method === "POST" && req.url === "/api/translate/dispatch") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      dispatched = { auth: seen(req), body: JSON.parse(raw) };
      if (d.dispatchStatus !== 200) {
        return send(res, d.dispatchStatus, { code: "guest.allowance_exhausted" });
      }
      send(res, 200, {
        sessionId: "s-1",
        version: 2,
        state: { translations: d.sessionTranslations },
      });
    });
    return;
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
  dispatched = {};
  authorizationHeaders = [];
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
    // As a browser: the session cookie, this origin and the session's token — never a bearer.
    expect(translateAuth).toEqual(BROWSER(base));
    expect(authorizationHeaders).toEqual([]);
    expect(r.out).toContain(
      "✓ a request without the session's token refused (auth.csrf_failed)"
    );
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

  it("fails a degraded instance when a probe it must have healthy is not (SMOKE_HEALTHY_PROBES, TASK-197)", async () => {
    deployment.readiness = {
      status: "degraded",
      ready: true,
      boot: "completed",
      checks: [
        { name: "database", status: "healthy", required: true },
        { name: "ai-provider", status: "unhealthy", required: false },
      ],
    };
    const r = await smoke({ SMOKE_BASE_URL: base, SMOKE_HEALTHY_PROBES: "ai-provider" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("not healthy: ai-provider");
    const missing = await smoke({
      SMOKE_BASE_URL: base,
      SMOKE_HEALTHY_PROBES: "google-tts",
    });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("not healthy: google-tts");
    deployment.readiness.checks[1] = {
      name: "ai-provider",
      status: "healthy",
      required: false,
    };
    deployment.readiness.status = "ready";
    const ok = await smoke({ SMOKE_BASE_URL: base, SMOKE_HEALTHY_PROBES: "ai-provider" });
    expect(ok.out).toContain("✓ healthy: ai-provider");
    expect(ok.code).toBe(0);
  });

  it("polls a required probe that is still pending, and passes once it answers healthy (TASK-197 round 1, M-1)", async () => {
    deployment.readiness = {
      status: "ready",
      ready: true,
      boot: "completed",
      checks: [{ name: "ai-provider", status: "healthy", required: false }],
    };
    readyCalls = 0;
    pendingCalls = 2;
    pendingReadiness = {
      status: "degraded",
      ready: true,
      boot: "completed",
      checks: [{ name: "ai-provider", status: "degraded", required: false }],
    };
    try {
      const r = await smoke({
        SMOKE_BASE_URL: base,
        SMOKE_HEALTHY_PROBES: "ai-provider",
        SMOKE_WAIT_SECONDS: "10",
        SMOKE_POLL_MS: "50",
      });
      expect(r.code).toBe(0);
      expect(r.out).toContain("✓ healthy: ai-provider");
      expect(readyCalls).toBeGreaterThan(2);
    } finally {
      pendingCalls = 0;
    }
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
    expect(r.out).toContain(
      "✓ guest session started (HttpOnly cookie, no token in the answer)"
    );
    expect(r.out).toContain("– translate: skipped (SMOKE_SKIP_TRANSLATE=1");
    expect(r.out).toContain("✓ smoke passed (translate skipped)");
    expect(r.code).toBe(0);
    expect(translateAuth).toBeUndefined();

    // Everything before it still has to pass.
    deployment.guestCookie = null;
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

  describe("the screen's own path: session, then dispatch (TASK-181)", () => {
    const SESSION = {
      SMOKE_SESSION_PATH: "/api/translate/session",
      SMOKE_DISPATCH_PATH: "/api/translate/dispatch",
      SMOKE_TRANSLATION_FIELD: "translated",
    };

    it("opens a session as a fresh guest and dispatches a translate intent into it", async () => {
      deployment.translations = [{ language: "French", translated: "Bonjour" }];
      const r = await smoke({ SMOKE_BASE_URL: base, ...SESSION });
      expect(r.out).toContain("✓ session opened (/api/translate/session)");
      expect(r.out).toContain("✓ dispatch: 1 translation(s) in the session");
      expect(r.code).toBe(0);
      expect(dispatched).toEqual({
        auth: BROWSER(base),
        body: {
          sessionId: "s-1",
          intent: { type: "translate", text: "Good morning", additionalLanguages: [] },
        },
      });
    });

    it("fails, naming the step, when the session or the dispatch is refused or empty", async () => {
      deployment.translations = [{ language: "French", translated: "Bonjour" }];
      deployment.sessionStatus = 401;
      let r = await smoke({ SMOKE_BASE_URL: base, ...SESSION });
      expect(r.code).toBe(1);
      expect(r.out).toContain("session: 401 auth.required, no session");

      deployment = { ...healthy(), translations: deployment.translations };
      deployment.dispatchStatus = 403;
      r = await smoke({ SMOKE_BASE_URL: base, ...SESSION });
      expect(r.code).toBe(1);
      expect(r.out).toContain("dispatch: 403 guest.allowance_exhausted, no translation");

      deployment = { ...healthy(), translations: deployment.translations };
      deployment.sessionTranslations = [];
      r = await smoke({ SMOKE_BASE_URL: base, ...SESSION });
      expect(r.code).toBe(1);
      expect(r.out).toContain("dispatch: 200, no translation");
    });

    it("sends the intent the app names (SMOKE_DISPATCH_INTENT)", async () => {
      deployment.translations = [{ language: "French", translated: "Bonjour" }];
      const intent = { type: "translate", text: "Hi", additionalLanguages: ["fr"] };
      const r = await smoke({
        SMOKE_BASE_URL: base,
        ...SESSION,
        SMOKE_DISPATCH_INTENT: JSON.stringify(intent),
      });
      expect(r.code).toBe(0);
      expect((dispatched.body as { intent: unknown }).intent).toEqual(intent);
    });
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
      { SMOKE_BASE_URL: base, SMOKE_HEALTHY_PROBES: "AI Provider" },
      { SMOKE_BASE_URL: base, SMOKE_SESSION_PATH: "/api/translate/session" },
      { SMOKE_BASE_URL: base, SMOKE_SESSION_PATH: "x", SMOKE_DISPATCH_PATH: "/api/d" },
      {
        SMOKE_BASE_URL: base,
        SMOKE_SESSION_PATH: "/api/s",
        SMOKE_DISPATCH_PATH: "/api/d",
        SMOKE_DISPATCH_INTENT: "[1]",
      },
    ]) {
      const r = await smoke(env as Record<string, string>);
      expect({ env, code: r.code }).toEqual({ env, code: 2 });
      expect(r.out).toContain("✗ settings:");
    }
  });
});

describe("deploy smoke: the guest session (ADR-057)", () => {
  it("fails when the guest's answer carries a token — at any depth (ADR-057: none may reach the browser; a build that predates it does)", async () => {
    deployment.guestBody = { success: true, token: "guest.payload.sig" };
    let r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "guest: the answer carries a token (token) — none may reach the browser"
    );
    deployment.guestBody = {
      success: true,
      session: { accessToken: "a", refresh_token: "r" },
    };
    r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("(session.accessToken, session.refresh_token)");
  });

  it("fails when no session cookie is set, or it is one script could read", async () => {
    deployment.guestCookie = null;
    let r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("guest: 200, no session cookie");

    // Not HttpOnly: page script could read the session id.
    deployment.guestCookie = `pf_session=${SESSION_ID}; Path=/; SameSite=lax`;
    r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("guest: the session cookie is not HttpOnly");

    deployment.guestCookie = `pf_session=${SESSION_ID}; Path=/api; Domain=example.com; HttpOnly`;
    r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.out).toContain(
      "guest: the session cookie is has a Domain, Path is not /, no SameSite=Lax"
    );
    expect(r.code).toBe(1);

    // Another cookie is not the session's.
    deployment.guestCookie = `pf_has_session=true; Path=/`;
    r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.out).toContain("guest: 200, no session cookie");
  });

  it("on https — every deployment — the cookie must be __Host-pf_session and Secure", async () => {
    // The stand-in is plain http, where browsers refuse a __Host- cookie: the rule for https is
    // asked of the script's own functions.
    const ask = (line: string, base: string) =>
      new Promise<string>((resolve, reject) =>
        execFile(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { cookieProblems, sessionCookieFrom } from ${JSON.stringify(SCRIPT)};
             const c = sessionCookieFrom([process.argv[1]]);
             console.log(JSON.stringify(c ? cookieProblems(c, process.argv[2]) : null));`,
            line,
            base,
          ],
          (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
        )
      );
    const good = `__Host-pf_session=${SESSION_ID}; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=lax`;
    expect(await ask(good, "https://app.example.com")).toBe("[]");
    expect(await ask(good.replace("; Secure", ""), "https://app.example.com")).toBe(
      '["not Secure"]'
    );
    expect(
      await ask(
        good.replace("__Host-pf_session", "pf_session"),
        "https://app.example.com"
      )
    ).toBe('["not __Host-pf_session"]');
    expect(await ask(good.replace("; HttpOnly", ""), "https://app.example.com")).toBe(
      '["not HttpOnly"]'
    );
    // A cleared cookie (no value) is no session cookie.
    expect(
      await ask("__Host-pf_session=; Path=/; Max-Age=0", "https://app.example.com")
    ).toBe("null");
  });

  it("fails when the session is not a guest's, or gives no forgery token", async () => {
    deployment.sessionStatusBody = { authenticated: false };
    let r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("guest: the session is not a guest's (200)");
    deployment.sessionStatusBody = {
      authenticated: true,
      user: { userId: "guest_1", isGuest: true },
    };
    r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain("guest: the session is not a guest's (200)");
  });

  it("fails when a state-changing request without the session's token is let through (the forgery defence is off)", async () => {
    deployment.forgeryRefused = false;
    const r = await smoke({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "forgery: expected 403 auth.csrf_failed without the session's token, got 200"
    );
  });
});
