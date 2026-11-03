/**
 * __tests__/mfa-step-up.test.ts — changing a second factor needs proof of the current one
 * (TASK-194, audit C-3)
 *
 * A bearer access token alone turned off a staff member's second factor (/api/auth/mfa/disable)
 * or re-enrolled it to another authenticator (/setup on an enrolled account), and with a phished
 * password an attacker then passed requireAdmin's MFA check for good. Every MFA route is listed:
 * a factor-changing one (FACTOR_CHANGING_ROUTES, platform/auth/mfa-routes.ts) or one that
 * changes no existing factor, with the reason. Each factor-changing route, called with a valid
 * token and no current code — or a wrong one — answers 4xx and changes nothing; a refused proof
 * is recorded; with the password and a current code, the change is made and recorded.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

const provider = {
  verifyToken: jest.fn(),
  setupMfa: jest.fn(),
  verifyMfaSetup: jest.fn(),
  disableMfa: jest.fn(),
  confirmCurrentFactor: jest.fn(),
};
jest.mock("@/platform/auth/config", () => ({
  getAuthProvider: () => provider,
  hasAuthProvider: () => true,
  registerAuthProvider: jest.fn(),
}));
jest.mock("@/platform/auth/auth-init", () => ({ initAuth: jest.fn() }));
jest.mock("@/platform/data", () => ({
  ...jest.requireActual("@/platform/data"),
  hasDatabase: () => true,
}));
const mockRecordAudit = jest.fn();
jest.mock("@/platform/auth/audit", () => ({
  ...jest.requireActual("@/platform/auth/audit"),
  recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
}));

import { resetRateLimiter } from "@/platform/rate-limit";
import { confirmStepUp, FACTOR_CHANGING_ROUTES } from "@/platform/auth/mfa-routes";
import { POST as setup } from "@/app/api/auth/mfa/setup/route";
import { POST as disable } from "@/app/api/auth/mfa/disable/route";

const USER = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";

/** MFA routes that change no existing factor, and why. */
const NOT_FACTOR_CHANGING: Readonly<Record<string, string>> = {
  "app/api/auth/mfa/verify/route.ts":
    "Completes an enrolment /setup started: the provider verifies a code of the pending secret only, and /setup on an enrolled account already required the current factor.",
};

const ROUTES: Record<string, (r: NextRequest) => Promise<Response>> = {
  "app/api/auth/mfa/setup/route.ts": setup as (r: NextRequest) => Promise<Response>,
  "app/api/auth/mfa/disable/route.ts": disable as (r: NextRequest) => Promise<Response>,
};

/** The provider call each factor-changing route makes once allowed. */
const CHANGE: Record<string, jest.Mock> = {
  "app/api/auth/mfa/setup/route.ts": provider.setupMfa,
  "app/api/auth/mfa/disable/route.ts": provider.disableMfa,
};

function req(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: "Bearer access-1",
      "x-forwarded-for": "203.0.113.7",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const enrolled = (mfaEnabled: boolean | undefined) =>
  provider.verifyToken.mockResolvedValue({
    sub: USER,
    email: "a@b.c",
    emailVerified: true,
    iat: 0,
    exp: 9_999_999_999,
    ...(mfaEnabled === undefined ? {} : { mfaEnabled }),
  });

beforeEach(() => {
  jest.clearAllMocks();
  resetRateLimiter();
  mockRecordAudit.mockResolvedValue(undefined);
  enrolled(true);
  provider.setupMfa.mockResolvedValue({
    success: true,
    secretCode: "S",
    qrCodeUri: "otpauth://x",
  });
  provider.disableMfa.mockResolvedValue({ success: true });
  provider.confirmCurrentFactor.mockImplementation(
    async (_t: string, password: string, code: string) =>
      password === "right" && code === "123456"
        ? { success: true }
        : { success: false, errorCode: "auth.code_invalid", error: "bad" }
  );
});

describe("every MFA route is classified (self-test of the list)", () => {
  it("lists each route under app/api/auth/mfa exactly once", () => {
    const dir = join(process.cwd(), "app/api/auth/mfa");
    const found = readdirSync(dir)
      .filter((d) => statSync(join(dir, d)).isDirectory())
      .map((d) => `app/api/auth/mfa/${d}/route.ts`)
      .sort();
    expect(found.length).toBeGreaterThan(2);
    expect(
      [...Object.keys(FACTOR_CHANGING_ROUTES), ...Object.keys(NOT_FACTOR_CHANGING)].sort()
    ).toEqual(found);
    expect(Object.keys(ROUTES).sort()).toEqual(
      Object.keys(FACTOR_CHANGING_ROUTES).sort()
    );
  });
});

describe.each(Object.keys(FACTOR_CHANGING_ROUTES))("%s (factor-changing)", (route) => {
  const call = (body?: unknown) => ROUTES[route](req(`/${route}`, body));

  it.each([
    ["no body", undefined],
    ["no current code", { password: "right" }],
    ["no password", { currentCode: "123456" }],
    ["a malformed code", { password: "right", currentCode: "12345" }],
    ["a code that is not a string", { password: "right", currentCode: 123456 }],
  ])("refuses a valid token with %s: 403 step-up, nothing changed", async (_l, body) => {
    const res = await call(body);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("auth.step_up_required");
    expect(CHANGE[route]).not.toHaveBeenCalled();
    expect(provider.confirmCurrentFactor).not.toHaveBeenCalled();
  });

  it("refuses a wrong current code, records the refused step-up, changes nothing", async () => {
    const res = await call({ password: "right", currentCode: "000000" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("auth.code_invalid");
    expect(CHANGE[route]).not.toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "login_failed",
        details: expect.objectContaining({ method: "mfa_step_up" }),
      })
    );
  });

  it("asks the provider for proof of the token's own factor, and then makes the change", async () => {
    const res = await call({ password: "right", currentCode: "123456" });
    expect(res.status).toBe(200);
    expect(provider.confirmCurrentFactor).toHaveBeenCalledWith(
      "access-1",
      "right",
      "123456"
    );
    expect(CHANGE[route]).toHaveBeenCalledWith("access-1");
  });

  it("holds an account whose factor state is unknown to the step-up (fail closed)", async () => {
    enrolled(undefined);
    const res = await call();
    expect(res.status).toBe(403);
    expect(CHANGE[route]).not.toHaveBeenCalled();
  });

  if (FACTOR_CHANGING_ROUTES[route].whenEnrolled) {
    it("needs no step-up for a first enrolment (no factor yet)", async () => {
      enrolled(false);
      const res = await call();
      expect(res.status).toBe(200);
      expect(provider.confirmCurrentFactor).not.toHaveBeenCalled();
    });
  } else {
    it("needs the step-up whatever the account's factor state", async () => {
      enrolled(false);
      const res = await call();
      expect(res.status).toBe(403);
      expect(CHANGE[route]).not.toHaveBeenCalled();
    });
  }
});

describe("disable records the change with its step-up", () => {
  it("records mfa_disabled after the proof", async () => {
    await disable(req("/x", { password: "right", currentCode: "123456" }));
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mfa_disabled",
        details: expect.objectContaining({ stepUp: "password+current_code" }),
      })
    );
  });
});

// TASK-194 round 1, B1: the step-up other routes reuse (the delegation consent).
describe("confirmStepUp, reused", () => {
  const caller = { sub: USER, accessToken: "access-1" };
  const call = (over: Record<string, unknown>) =>
    confirmStepUp({
      request: req("/api/agent/delegation/authorize"),
      caller,
      purpose: "agent-consent",
      password: "pw",
      currentCode: undefined,
      ...over,
    });

  beforeEach(() => provider.confirmCurrentFactor.mockReset());

  it("without allowPasswordOnly a code is required: no proof, no provider call", async () => {
    const r = await call({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect((await r.response.json()).code).toBe("auth.step_up_required");
    expect(provider.confirmCurrentFactor).not.toHaveBeenCalled();
  });

  it("allowPasswordOnly: a password alone is put to the provider with no code", async () => {
    provider.confirmCurrentFactor.mockResolvedValue({ success: true });
    expect(await call({ allowPasswordOnly: true })).toEqual({ ok: true });
    expect(provider.confirmCurrentFactor).toHaveBeenCalledWith("access-1", "pw", null);
  });

  it("a code, when given, must be six digits, and is passed on", async () => {
    provider.confirmCurrentFactor.mockResolvedValue({ success: true });
    const bad = await call({ allowPasswordOnly: true, currentCode: "12ab56" });
    expect(bad.ok).toBe(false);
    expect(await call({ allowPasswordOnly: true, currentCode: "123456" })).toEqual({
      ok: true,
    });
    expect(provider.confirmCurrentFactor).toHaveBeenCalledWith(
      "access-1",
      "pw",
      "123456"
    );
  });

  it("no password, or no bearer: refused before the provider", async () => {
    for (const over of [
      { allowPasswordOnly: true, password: "" },
      { allowPasswordOnly: true, password: 5 },
    ]) {
      const r = await call(over);
      expect(r.ok).toBe(false);
    }
    const noBearer = await confirmStepUp({
      request: req("/x"),
      caller: { sub: USER, accessToken: "" },
      purpose: "agent-consent",
      password: "pw",
      currentCode: undefined,
      allowPasswordOnly: true,
    });
    expect(noBearer.ok).toBe(false);
    expect(provider.confirmCurrentFactor).not.toHaveBeenCalled();
  });
});
