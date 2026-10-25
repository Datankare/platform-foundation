/**
 * __tests__/auth-sessions.test.ts — Sessions after the October 2026 audit, Wave 2
 *
 * X-17 / A-14 / A-17: the refresh token never reaches the browser's script-readable storage or
 * a response body (an httpOnly, SameSite=Strict cookie for the auth routes only), the ID token
 * is never returned, the session is renewed through /api/auth/refresh, and sign-out revokes
 * what it can and reports a revocation that failed. A-12: sign-ins, failed sign-ins, sign-outs
 * and MFA changes are recorded; a session whose record cannot be written is not handed out.
 * A-9: MFA enrolment exists, is rate limited per account, and is recorded.
 *
 * Hostile cases: a forged or malformed refresh cookie, a renewed session for another user, a
 * guest token at sign-out, an audit outage, a malformed TOTP code, an unauthenticated caller.
 */

import { NextRequest } from "next/server";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

const provider = {
  signIn: jest.fn(),
  signOut: jest.fn(),
  refreshToken: jest.fn(),
  verifyToken: jest.fn(),
  respondToMfaChallenge: jest.fn(),
  setupMfa: jest.fn(),
  verifyMfaSetup: jest.fn(),
  disableMfa: jest.fn(),
};
jest.mock("@/platform/auth/config", () => ({
  getAuthProvider: () => provider,
  hasAuthProvider: () => true,
  registerAuthProvider: jest.fn(),
}));
jest.mock("@/platform/auth/auth-init", () => ({ initAuth: jest.fn() }));

const mockHasDatabase = jest.fn(() => true);
jest.mock("@/platform/data", () => ({
  ...jest.requireActual("@/platform/data"),
  hasDatabase: () => mockHasDatabase(),
}));
const mockRecordAudit = jest.fn();
jest.mock("@/platform/auth/audit", () => ({
  ...jest.requireActual("@/platform/auth/audit"),
  recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
}));
// Tenancy binding is tested on its own (auth-session-tenant); here every identity is the tenant's.
jest.mock("@/platform/tenancy/identity", () => ({
  ...jest.requireActual("@/platform/tenancy/identity"),
  sessionTenantRefusal: jest.fn(async () => null),
}));

import { resetRateLimiter } from "@/platform/rate-limit";
import { POST as signIn } from "@/app/api/auth/sign-in/route";
import { POST as signOut } from "@/app/api/auth/sign-out/route";
import { POST as refresh } from "@/app/api/auth/refresh/route";
import { POST as mfaChallenge } from "@/app/api/auth/mfa-challenge/route";
import { POST as mfaSetup } from "@/app/api/auth/mfa/setup/route";
import { POST as mfaVerify } from "@/app/api/auth/mfa/verify/route";
import { POST as mfaDisable } from "@/app/api/auth/mfa/disable/route";
import { readRefreshCookie } from "@/platform/auth/auth-response";
import { requestOrigin } from "@/platform/auth/auth-events";

const USER = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f01234567";

function req(
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; cookie?: string } = {}
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.7",
      "user-agent": "jest",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

const signedIn = {
  success: true,
  userId: USER,
  accessToken: "access-1",
  refreshToken: "refresh.with.dots",
  idToken: "id-token",
  expiresIn: 3600,
};

beforeEach(() => {
  jest.clearAllMocks();
  resetRateLimiter();
  mockHasDatabase.mockReturnValue(true);
  mockRecordAudit.mockResolvedValue(undefined);
  provider.verifyToken.mockResolvedValue({
    sub: USER,
    email: "a@b.c",
    emailVerified: true,
    iat: 0,
    exp: 9_999_999_999,
  });
});

describe("sign-in hands out a session (X-17, A-12, A-17)", () => {
  it("returns the access token only; the refresh token goes into an httpOnly cookie", async () => {
    provider.signIn.mockResolvedValue(signedIn);
    const res = await signIn(
      req("/api/auth/sign-in", { body: { email: "a@b.c", password: "p" } })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      userId: USER,
      accessToken: "access-1",
      expiresIn: 3600,
    });
    const cookie = res.cookies.get("pf_refresh");
    expect(cookie).toMatchObject({
      value: `${USER}.refresh.with.dots`,
      httpOnly: true,
      sameSite: "strict",
      path: "/api/auth",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.cookies.get("pf_has_session")?.value).toBe("true");
  });

  it("records the sign-in before the session is returned, with where it came from", async () => {
    provider.signIn.mockResolvedValue(signedIn);
    await signIn(req("/api/auth/sign-in", { body: { email: "a@b.c", password: "p" } }));
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "login_success",
        actorId: USER,
        details: { method: "password" },
        ipAddress: "203.0.113.7",
        userAgent: "jest",
      })
    );
    // Never the email address.
    expect(JSON.stringify(mockRecordAudit.mock.calls)).not.toContain("a@b.c");
  });

  it("hands out no session when the record cannot be written, and revokes the tokens", async () => {
    provider.signIn.mockResolvedValue(signedIn);
    mockRecordAudit.mockRejectedValueOnce(new Error("audit down"));
    const res = await signIn(
      req("/api/auth/sign-in", { body: { email: "a@b.c", password: "p" } })
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "service.unavailable",
      params: { service: "audit" },
    });
    expect(JSON.stringify(body)).not.toContain("access-1");
    expect(res.cookies.get("pf_refresh")).toBeUndefined();
    expect(provider.signOut).toHaveBeenCalledWith("access-1", "refresh.with.dots");
  });

  it("records a failed sign-in by its code, and still refuses it when recording fails", async () => {
    provider.signIn.mockResolvedValue({
      success: false,
      error: "Incorrect",
      errorCode: "auth.invalid_credentials",
    });
    mockRecordAudit.mockRejectedValueOnce(new Error("audit down"));
    const res = await signIn(
      req("/api/auth/sign-in", { body: { email: "a@b.c", password: "x" } })
    );
    expect(res.status).toBe(401);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "login_failed",
        details: { method: "password", code: "auth.invalid_credentials" },
      })
    );
  });

  it("answers an MFA challenge step without recording a sign-in", async () => {
    provider.signIn.mockResolvedValue({
      success: false,
      mfaRequired: true,
      mfaSession: "s",
    });
    const res = await signIn(
      req("/api/auth/sign-in", { body: { email: "a@b.c", password: "p" } })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mfaRequired: true, mfaSession: "s" });
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("answers the MFA challenge for the user named, and records it as an MFA sign-in", async () => {
    provider.respondToMfaChallenge.mockResolvedValue(signedIn);
    const res = await mfaChallenge(
      req("/api/auth/mfa-challenge", {
        body: { session: "s", code: "123456", username: "a@b.c" },
      })
    );
    expect(res.status).toBe(200);
    expect(provider.respondToMfaChallenge).toHaveBeenCalledWith("s", "123456", "a@b.c");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "login_success", details: { method: "mfa" } })
    );
  });

  it("does not record or cookie an id that is not a user id", async () => {
    provider.signIn.mockResolvedValue({ ...signedIn, userId: "has.dots" });
    const res = await signIn(
      req("/api/auth/sign-in", { body: { email: "a@b.c", password: "p" } })
    );
    expect(res.cookies.get("pf_refresh")).toBeUndefined();
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "login_success", actorId: undefined })
    );
  });
});

describe("POST /api/auth/refresh (A-14)", () => {
  const cookie = (value: string) => `pf_refresh=${value}`;

  it.each([
    ["no cookie", undefined],
    ["an empty cookie", ""],
    ["a cookie with no user id", "refresh-only"],
    ["a cookie with a malformed user id", "../x.refresh"],
    ["an oversized cookie", `${USER}.${"a".repeat(9000)}`],
  ])("refuses %s, clears the cookies and never calls the provider", async (_l, value) => {
    const res = await refresh(
      req("/api/auth/refresh", value !== undefined ? { cookie: cookie(value) } : {})
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth.token_invalid");
    expect(res.headers.get("set-cookie")).toMatch(/pf_refresh=;.*Max-Age=0/i);
    expect(provider.refreshToken).not.toHaveBeenCalled();
  });

  it("renews the session for the cookie's user", async () => {
    provider.refreshToken.mockResolvedValue({
      userId: USER,
      accessToken: "access-2",
      refreshToken: "refresh.with.dots",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await refresh(
      req("/api/auth/refresh", { cookie: cookie(`${USER}.refresh.with.dots`) })
    );
    expect(res.status).toBe(200);
    expect(provider.refreshToken).toHaveBeenCalledWith("refresh.with.dots", USER);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, userId: USER, accessToken: "access-2" });
    expect(body).not.toHaveProperty("refreshToken");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["the provider refuses (revoked, expired)", null],
    [
      "the provider answers for another user",
      { userId: OTHER, accessToken: "a", refreshToken: "r", expiresAt: 0 },
    ],
    [
      "the provider returns no access token",
      { userId: USER, accessToken: "", refreshToken: "r", expiresAt: 0 },
    ],
  ])("refuses when %s", async (_l, session) => {
    provider.refreshToken.mockResolvedValue(session);
    const res = await refresh(req("/api/auth/refresh", { cookie: cookie(`${USER}.r`) }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toMatch(/pf_refresh=;.*Max-Age=0/i);
  });

  it("answers a coded 500 when the provider throws", async () => {
    provider.refreshToken.mockRejectedValue(new Error("down"));
    const res = await refresh(req("/api/auth/refresh", { cookie: cookie(`${USER}.r`) }));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("internal.error");
  });

  it("parses only <user id>.<token>, splitting at the first dot", () => {
    expect(readRefreshCookie(`${USER}.a.b.c`)).toEqual({
      userId: USER,
      refreshToken: "a.b.c",
    });
    expect(readRefreshCookie(".token")).toBeNull();
    expect(readRefreshCookie(`${USER}.`)).toBeNull();
  });
});

describe("POST /api/auth/sign-out (X-17, A-12)", () => {
  it("revokes the refresh cookie's token and the bearer's sign-in, clears both cookies, records it", async () => {
    provider.signOut.mockResolvedValue(undefined);
    const res = await signOut(
      req("/api/auth/sign-out", {
        headers: { authorization: "Bearer access-1" },
        cookie: `pf_refresh=${USER}.refresh-1`,
      })
    );
    expect(res.status).toBe(200);
    expect(provider.signOut).toHaveBeenCalledWith("access-1", "refresh-1");
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/pf_refresh=;.*Max-Age=0/i);
    expect(set).toMatch(/pf_has_session=;.*Max-Age=0/i);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "logout", actorId: USER })
    );
  });

  it("revokes the refresh token even without an access token", async () => {
    provider.signOut.mockResolvedValue(undefined);
    await signOut(req("/api/auth/sign-out", { cookie: `pf_refresh=${USER}.refresh-1` }));
    expect(provider.signOut).toHaveBeenCalledWith("", "refresh-1");
  });

  it("never sends a guest token to the auth provider", async () => {
    const res = await signOut(
      req("/api/auth/sign-out", { headers: { authorization: "Bearer guest.abc.def" } })
    );
    expect(res.status).toBe(200);
    expect(provider.signOut).not.toHaveBeenCalled();
  });

  it("reports a revocation that failed, and still ends the browser's session", async () => {
    provider.signOut.mockRejectedValue(new Error("cognito down"));
    const res = await signOut(
      req("/api/auth/sign-out", {
        headers: { authorization: "Bearer access-1" },
        cookie: `pf_refresh=${USER}.refresh-1`,
      })
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("set-cookie")).toMatch(/pf_refresh=;.*Max-Age=0/i);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});

describe("MFA enrolment (A-9)", () => {
  const bearer = { authorization: "Bearer access-1" };

  it.each([
    ["setup", () => mfaSetup(req("/api/auth/mfa/setup"))],
    [
      "verify",
      () => mfaVerify(req("/api/auth/mfa/verify", { body: { code: "123456" } })),
    ],
    ["disable", () => mfaDisable(req("/api/auth/mfa/disable"))],
  ])("%s refuses an unauthenticated caller", async (_l, call) => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(provider.setupMfa).not.toHaveBeenCalled();
    expect(provider.verifyMfaSetup).not.toHaveBeenCalled();
    expect(provider.disableMfa).not.toHaveBeenCalled();
  });

  it("setup returns the authenticator secret, uncached", async () => {
    provider.setupMfa.mockResolvedValue({
      success: true,
      secretCode: "SECRET",
      qrCodeUri: "otpauth://x",
    });
    const res = await mfaSetup(req("/api/auth/mfa/setup", { headers: bearer }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      secretCode: "SECRET",
      qrCodeUri: "otpauth://x",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(provider.setupMfa).toHaveBeenCalledWith("access-1");
  });

  it.each([["12345"], ["1234567"], ["abcdef"], [123456], [null], [["123456"]]])(
    "verify refuses the code %p before the provider sees it",
    async (code) => {
      const res = await mfaVerify(
        req("/api/auth/mfa/verify", { headers: bearer, body: { code } })
      );
      expect(res.status).toBe(400);
      expect(provider.verifyMfaSetup).not.toHaveBeenCalled();
    }
  );

  it("verify turns MFA on and records it", async () => {
    provider.verifyMfaSetup.mockResolvedValue({ success: true });
    const res = await mfaVerify(
      req("/api/auth/mfa/verify", { headers: bearer, body: { code: "123456" } })
    );
    expect(res.status).toBe(200);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mfa_enabled", actorId: USER })
    );
  });

  it("verify answers 503 when the change cannot be recorded", async () => {
    provider.verifyMfaSetup.mockResolvedValue({ success: true });
    mockRecordAudit.mockRejectedValueOnce(new Error("audit down"));
    const res = await mfaVerify(
      req("/api/auth/mfa/verify", { headers: bearer, body: { code: "123456" } })
    );
    expect(res.status).toBe(503);
  });

  it("verify passes a wrong code's refusal on, coded", async () => {
    provider.verifyMfaSetup.mockResolvedValue({
      success: false,
      error: "bad",
      errorCode: "auth.code_invalid",
    });
    const res = await mfaVerify(
      req("/api/auth/mfa/verify", { headers: bearer, body: { code: "000000" } })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("auth.code_invalid");
  });

  it("disable turns MFA off and records it", async () => {
    provider.disableMfa.mockResolvedValue({ success: true });
    const res = await mfaDisable(req("/api/auth/mfa/disable", { headers: bearer }));
    expect(res.status).toBe(200);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mfa_disabled", actorId: USER })
    );
  });

  it("limits code guesses per account, from any address", async () => {
    provider.verifyMfaSetup.mockResolvedValue({
      success: false,
      errorCode: "auth.code_invalid",
    });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await mfaVerify(
        req("/api/auth/mfa/verify", {
          headers: { ...bearer, "x-forwarded-for": `198.51.100.${i}` },
          body: { code: "000000" },
        })
      );
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(provider.verifyMfaSetup.mock.calls.length).toBeLessThanOrEqual(10);
  });
});

describe("requestOrigin", () => {
  it("records an address only when it is one", () => {
    const headers = (ip: string) =>
      ({ headers: new Headers({ "x-forwarded-for": ip }) }) as { headers: Headers };
    expect(requestOrigin(headers("203.0.113.9")).ipAddress).toBe("203.0.113.9");
    expect(requestOrigin(headers("2001:db8::1")).ipAddress).toBe("2001:db8::1");
    expect(
      requestOrigin(headers("not-an-ip'); drop table x;--")).ipAddress
    ).toBeUndefined();
    expect(requestOrigin({ headers: new Headers() }).ipAddress).toBeUndefined();
  });

  it("bounds the user agent", () => {
    const ua = "x".repeat(5000);
    expect(
      requestOrigin({ headers: new Headers({ "user-agent": ua }) }).userAgent
    ).toHaveLength(256);
  });
});
