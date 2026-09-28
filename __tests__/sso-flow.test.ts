/**
 * TASK-101 — SSO through the hosted sign-in: helpers, start route, callback route.
 * Security properties under test: state is required and compared exactly; the PKCE verifier
 * stays server-side and reaches the token exchange; the attempt is single-use; only configured
 * providers can be started; the ID token is not returned.
 */

import { NextRequest } from "next/server";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  generateRequestId: () => "test-req-id",
}));

const mockProvider = {
  initiateSso: jest.fn(),
  handleSsoCallback: jest.fn(),
};

jest.mock("@/platform/auth/config", () => ({
  getAuthProvider: () => mockProvider,
  hasAuthProvider: () => true,
  registerAuthProvider: jest.fn(),
}));

jest.mock("@/platform/auth/auth-init", () => ({ initAuth: jest.fn() }));

import {
  SSO_COOKIE,
  decodeSsoAttempt,
  encodeSsoAttempt,
  idTokenIdentity,
  isSsoProvider,
  pkceChallenge,
  randomToken,
  sameState,
  ssoRedirectUri,
} from "@/platform/auth/sso";
import { GET as start } from "@/app/api/auth/sso/[provider]/route";
import { POST as callback } from "@/app/api/auth/sso/callback/route";

const ORIGIN = "https://playform-staging.vercel.app";
const SSO_ENV = {
  AUTH_PROVIDER: "cognito",
  NEXT_PUBLIC_COGNITO_USER_POOL_ID: "us-east-1_AbC123",
  NEXT_PUBLIC_COGNITO_CLIENT_ID: "client123",
  NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN: "pfx.auth.us-east-1.amazoncognito.com",
  SSO_PROVIDERS: "google",
};

const orig = { ...process.env };
beforeEach(() => {
  process.env = { ...orig, ...SSO_ENV };
  jest.clearAllMocks();
});
afterAll(() => {
  process.env = orig;
});

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

// ── helpers ──────────────────────────────────────────────────────────────

describe("sso helpers", () => {
  it("randomToken is 43 base64url characters and unique", () => {
    const a = randomToken();
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });

  it("pkceChallenge is the RFC 7636 S256 transform (Appendix B vector)", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
  });

  it("round-trips an attempt and rejects malformed cookies", () => {
    const attempt = {
      provider: "google" as const,
      state: randomToken(),
      verifier: randomToken(),
    };
    expect(decodeSsoAttempt(encodeSsoAttempt(attempt))).toEqual(attempt);
    for (const bad of [
      undefined,
      "",
      "google.short.short",
      `facebook.${randomToken()}.${randomToken()}`,
      `google.${randomToken()}`,
      `google.${randomToken()}.${randomToken()}.x`,
    ]) {
      expect(decodeSsoAttempt(bad)).toBeNull();
    }
  });

  it("sameState is exact", () => {
    const s = randomToken();
    expect(sameState(s, s)).toBe(true);
    expect(sameState(s, s.slice(0, -1) + (s.endsWith("A") ? "B" : "A"))).toBe(false);
    expect(sameState(s, s + "x")).toBe(false);
    expect(sameState(s, undefined)).toBe(false);
  });

  it("isSsoProvider and the redirect address", () => {
    expect(isSsoProvider("google")).toBe(true);
    expect(isSsoProvider("facebook")).toBe(false);
    expect(isSsoProvider(1)).toBe(false);
    expect(ssoRedirectUri(ORIGIN)).toBe(`${ORIGIN}/auth/callback`);
  });

  it("idTokenIdentity reads the email claims, safely", () => {
    const tok = `h.${b64url({ email: "r@x.com", email_verified: "true" })}.s`;
    expect(idTokenIdentity(tok)).toEqual({ email: "r@x.com", emailVerified: true });
    expect(idTokenIdentity(`h.${b64url({ email_verified: false })}.s`)).toEqual({
      email: "",
      emailVerified: false,
    });
    expect(idTokenIdentity(undefined)).toEqual({ email: "", emailVerified: false });
    expect(idTokenIdentity("not.a+jwt.x")).toEqual({ email: "", emailVerified: false });
  });
});

// ── GET /api/auth/sso/[provider] ─────────────────────────────────────────

function startReq(provider: string) {
  return start(new NextRequest(`${ORIGIN}/api/auth/sso/${provider}`), {
    params: Promise.resolve({ provider }),
  });
}

describe("GET /api/auth/sso/[provider]", () => {
  it("redirects to the hosted sign-in with state and a challenge, and sets the attempt cookie", async () => {
    mockProvider.initiateSso.mockResolvedValue({
      success: true,
      redirectUrl: "https://pfx.auth.us-east-1.amazoncognito.com/oauth2/authorize?x=1",
    });
    const res = await startReq("google");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("pfx.auth.us-east-1.amazoncognito.com");

    const [provider, redirectUri, options] = mockProvider.initiateSso.mock.calls[0];
    expect(provider).toBe("google");
    expect(redirectUri).toBe(`${ORIGIN}/auth/callback`);

    const cookie = res.cookies.get(SSO_COOKIE);
    const attempt = decodeSsoAttempt(cookie?.value);
    expect(attempt).not.toBeNull();
    expect(options.state).toBe(attempt?.state);
    expect(options.codeChallenge).toBe(await pkceChallenge(attempt?.verifier as string));
    expect(options.codeChallenge).not.toBe(attempt?.verifier);
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/api/auth/sso",
    });
    expect(res.headers.get("location")).not.toContain(attempt?.verifier as string);
  });

  it("refuses an unconfigured or unknown provider without calling the provider", async () => {
    for (const p of ["apple", "facebook"]) {
      const res = await startReq(p);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `${ORIGIN}/auth?error=feature.not_configured`
      );
    }
    delete process.env.SSO_PROVIDERS;
    expect((await startReq("google")).headers.get("location")).toContain(
      "error=feature.not_configured"
    );
    expect(mockProvider.initiateSso).not.toHaveBeenCalled();
  });

  it("returns to sign-in with the provider's code when initiation fails", async () => {
    mockProvider.initiateSso.mockResolvedValue({ success: false, error: "x" });
    const res = await startReq("google");
    expect(res.headers.get("location")).toBe(`${ORIGIN}/auth?error=auth.sso_failed`);
    expect(res.cookies.get(SSO_COOKIE)).toBeUndefined();
  });
});

// ── POST /api/auth/sso/callback ──────────────────────────────────────────

function callbackReq(body: unknown, cookie?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie !== undefined) headers.cookie = `${SSO_COOKIE}=${cookie}`;
  return callback(
    new NextRequest(`${ORIGIN}/api/auth/sso/callback`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

function attemptCookie(state = randomToken(), verifier = randomToken()) {
  return {
    state,
    verifier,
    cookie: encodeSsoAttempt({ provider: "google", state, verifier }),
  };
}

function cleared(
  res: Response & {
    cookies: { get(n: string): { value: string; maxAge?: number } | undefined };
  }
) {
  const c = res.cookies.get(SSO_COOKIE);
  return c?.value === "" && c.maxAge === 0;
}

describe("POST /api/auth/sso/callback", () => {
  it("exchanges the code with the stored verifier and returns the session, not the ID token", async () => {
    const { state, verifier, cookie } = attemptCookie();
    mockProvider.handleSsoCallback.mockResolvedValue({
      success: true,
      userId: "u-1",
      accessToken: "access",
      refreshToken: "refresh",
      idToken: `h.${b64url({ email: "r@x.com", email_verified: true })}.s`,
      expiresIn: 3600,
    });

    const res = await callbackReq({ code: "the-code", state }, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      userId: "u-1",
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 3600,
      email: "r@x.com",
      emailVerified: true,
    });
    expect(mockProvider.handleSsoCallback).toHaveBeenCalledWith(
      "google",
      "the-code",
      `${ORIGIN}/auth/callback`,
      { codeVerifier: verifier }
    );
    expect(res.cookies.get("pf_has_session")?.value).toBe("true");
    expect(cleared(res)).toBe(true);
  });

  it("refuses a state that doesn't match, and never exchanges", async () => {
    const { cookie } = attemptCookie();
    const res = await callbackReq({ code: "c", state: randomToken() }, cookie);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth.sso_failed");
    expect(mockProvider.handleSsoCallback).not.toHaveBeenCalled();
    expect(cleared(res)).toBe(true);
  });

  it("refuses when there is no attempt from this browser", async () => {
    for (const cookie of [undefined, "garbage"]) {
      const res = await callbackReq({ code: "c", state: randomToken() }, cookie);
      expect((await res.json()).code).toBe("auth.sso_failed");
    }
    expect(mockProvider.handleSsoCallback).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    const { cookie } = attemptCookie();
    expect((await (await callbackReq("{", cookie)).json()).code).toBe(
      "request.invalid_json"
    );
    expect((await (await callbackReq({ state: "s" }, cookie)).json()).code).toBe(
      "request.missing_fields"
    );
    expect(mockProvider.handleSsoCallback).not.toHaveBeenCalled();
  });

  it("refuses when the provider is no longer configured", async () => {
    const { state, cookie } = attemptCookie();
    delete process.env.SSO_PROVIDERS;
    const res = await callbackReq({ code: "c", state }, cookie);
    expect(res.status).toBe(501);
    expect(mockProvider.handleSsoCallback).not.toHaveBeenCalled();
  });

  it("maps a failed exchange to its code (default auth.sso_failed), no session cookie", async () => {
    const { state, cookie } = attemptCookie();
    mockProvider.handleSsoCallback.mockResolvedValue({ success: false, error: "400" });
    const res = await callbackReq({ code: "c", state }, cookie);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth.sso_failed");
    expect(res.cookies.get("pf_has_session")).toBeUndefined();
    expect(cleared(res)).toBe(true);
  });
});
