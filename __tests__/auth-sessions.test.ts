/**
 * __tests__/auth-sessions.test.ts — the auth routes and the server-side session (ADR-057;
 * audit X-17, A-12, A-14, A-17, A-9)
 *
 * A sign-in keeps the provider's tokens on the server and hands the browser only an HttpOnly
 * session cookie — no token in any body or readable cookie; the ID token is never kept. A session
 * whose `login_success` record cannot be written is not started, and its tokens are revoked.
 * Sign-out ends the session in its record and revokes its refresh token. A browser signed in
 * before ADR-057 is moved over from its legacy refresh cookie. MFA enrolment uses the session's
 * token for that one purpose, and a factor change moves the session to a new id.
 *
 * Hostile cases: a forged, edited or wrong-key legacy cookie; a legacy cookie whose renewal is
 * another user's; a cross-site migration; an audit outage; a malformed TOTP code; an
 * unauthenticated caller; a provider that fails to revoke.
 */

import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

const provider = {
  signIn: jest.fn(),
  signOut: jest.fn(),
  signOutEverywhere: jest.fn(),
  renewSession: jest.fn(),
  verifyToken: jest.fn(),
  respondToMfaChallenge: jest.fn(),
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
import { POST as migrate } from "@/app/api/auth/session/migrate/route";
import { POST as mfaChallenge } from "@/app/api/auth/mfa-challenge/route";
import { POST as mfaSetup } from "@/app/api/auth/mfa/setup/route";
import { POST as mfaVerify } from "@/app/api/auth/mfa/verify/route";
import { POST as mfaDisable } from "@/app/api/auth/mfa/disable/route";
import { readLegacyRefreshCookie } from "@/platform/auth/auth-response";
import { requestOrigin } from "@/platform/auth/auth-events";
import { hashSessionId } from "@/platform/auth/session";
import {
  MemorySessionStore,
  getSessionStore,
  setSessionStore,
} from "@/platform/auth/session-store";
import { openForProvider, openIdentity } from "@/platform/auth/session-vault";
import { DEFAULT_TENANT_ID, runWithTenant } from "@/platform/tenancy/context";
import {
  sessionCookieAttributes,
  sessionCookieOf,
  startTestSession,
  type TestSession,
} from "./helpers/session";

const USER = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f01234567";
const COOKIE_KEY = "legacy-cookie-key-".padEnd(48, "k");
const PREVIOUS_KEY = "previous-cookie-key-".padEnd(48, "p");

/** The refresh cookie a deployment before ADR-057 issued for `userId` and `token` (review 17 M1). */
const legacyCookie = (userId: string, token: string, key = COOKIE_KEY): string =>
  `pf_refresh=${userId}.${createHmac("sha256", key)
    .update(`pf_refresh.v1\0${userId}\0${token}`)
    .digest("base64url")}.${token}`;

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
      origin: "http://localhost",
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

const inTenant = <T>(fn: () => T): T =>
  runWithTenant({ tenantId: DEFAULT_TENANT_ID, mode: "single" }, fn);
const recordOf = (idHash: string) => inTenant(() => getSessionStore().find(idHash));
/** The record of the session a response's cookie names. */
async function sessionOf(res: Response) {
  const cookie = sessionCookieOf(res);
  expect(cookie).not.toBeNull();
  return (await recordOf(hashSessionId(cookie!.split("=")[1])))!;
}
/** Everything in a response a page's script could read. */
const readable = async (res: Response) =>
  `${await res.clone().text()}\n${[...res.headers.entries()]
    .filter(([name]) => name !== "set-cookie")
    .join("\n")}`;

const savedEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  resetRateLimiter();
  setSessionStore(new MemorySessionStore());
  process.env.REFRESH_COOKIE_KEY = COOKIE_KEY;
  delete process.env.REFRESH_COOKIE_KEY_PREVIOUS;
  mockHasDatabase.mockReturnValue(true);
  mockRecordAudit.mockResolvedValue(undefined);
  provider.signOut.mockResolvedValue(undefined);
  provider.signOutEverywhere.mockResolvedValue({ success: true });
  provider.verifyToken.mockResolvedValue({
    sub: USER,
    email: "a@b.c",
    emailVerified: true,
    iat: 0,
    exp: 9_999_999_999,
  });
});
afterAll(() => {
  process.env = savedEnv;
});

// hostile:self n/a: each route acts on the session presented: the factor routes change the caller's own factor, and none names another account
// hostile:id-spelling n/a: the one comparison of ids here (a renewed session's user with the legacy cookie's) is sameId's, whose spellings are id-equality.test's cases

describe("sign-in starts a server-side session (ADR-057; X-17, A-12, A-17)", () => {
  it("answers who signed in and no token; the tokens are sealed in the session, the browser gets an HttpOnly cookie", async () => {
    provider.signIn.mockResolvedValue(signedIn);
    const res = await signIn(
      req("/api/auth/sign-in", { body: { email: "a@b.c", password: "p" } })
    );
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toEqual({ success: true, userId: USER });
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Nothing a script can read holds a token.
    expect(await readable(res)).not.toMatch(/access-1|refresh\.with\.dots|id-token/);
    for (const line of res.headers.getSetCookie()) {
      expect(line).not.toMatch(/access-1|refresh\.with\.dots|id-token/);
    }
    expect(sessionCookieAttributes(res)).toMatchObject({
      httponly: "true",
      samesite: "lax",
      path: "/",
      "max-age": String(30 * 86400),
    });
    expect(sessionCookieAttributes(res)!.domain).toBeUndefined();

    const record = await sessionOf(res);
    expect(record).toMatchObject({ kind: "user", subject: USER, method: "password" });
    expect(record.sealedTokens).not.toMatch(/access-1|refresh\.with\.dots/);
    expect(openIdentity(record.sealedTokens, record.idHash)).toMatchObject({
      token: "access-1",
      renewable: true,
    });
    expect(openForProvider(record.sealedTokens, record.idHash, "renewal")).toBe(
      "refresh.with.dots"
    );
    // The ID token is not kept anywhere.
    expect(JSON.stringify(record)).not.toContain("id-token");
  });

  it("clears what a sign-in before ADR-057 left: the refresh cookie and the readable indicator", async () => {
    provider.signIn.mockResolvedValue(signedIn);
    const res = await signIn(
      req("/api/auth/sign-in", { body: { email: "a@b.c", password: "p" } })
    );
    const lines = res.headers.getSetCookie();
    expect(lines.find((l) => l.startsWith("pf_refresh=;"))).toMatch(/Max-Age=0/i);
    expect(lines.find((l) => l.startsWith("pf_has_session=;"))).toMatch(/Max-Age=0/i);
    // Nothing sets either again.
    expect(lines.filter((l) => /^pf_(?:refresh|has_session)=[^;]/.test(l))).toEqual([]);
  });

  it("records the sign-in before the session is started, with where it came from", async () => {
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

  it("starts no session when the record cannot be written, and revokes the tokens", async () => {
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
    expect(sessionCookieOf(res)).toBeNull();
    await expect(inTenant(() => getSessionStore().countLive(USER))).resolves.toBe(0);
    // The refresh token is revoked; the access token is not sent anywhere.
    expect(provider.signOut).toHaveBeenCalledWith("", "refresh.with.dots");
  });

  it("[hostile:store-down] starts no session, and revokes the tokens, when the session cannot be recorded", async () => {
    provider.signIn.mockResolvedValue(signedIn);
    const broken = new MemorySessionStore();
    broken.open = async () => {
      throw new Error("database down");
    };
    setSessionStore(broken);
    const res = await signIn(
      req("/api/auth/sign-in", { body: { email: "a@b.c", password: "p" } })
    );
    expect(res.status).toBe(500);
    expect(sessionCookieOf(res)).toBeNull();
    expect(await readable(res)).not.toMatch(/access-1|refresh\.with\.dots/);
    expect(provider.signOut).toHaveBeenCalledWith("", "refresh.with.dots");
  });

  it("a provider 'success' without a token or a user is no session", async () => {
    for (const result of [
      { success: true, userId: USER },
      { success: true, accessToken: "access-1" },
    ]) {
      provider.signIn.mockResolvedValue(result);
      const res = await signIn(
        req("/api/auth/sign-in", { body: { email: "a@b.c", password: "p" } })
      );
      expect(res.status).toBe(500);
      expect(sessionCookieOf(res)).toBeNull();
    }
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
    expect(sessionCookieOf(res)).toBeNull();
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "login_failed",
        details: { method: "password", code: "auth.invalid_credentials" },
      })
    );
  });

  it("answers an MFA challenge step without a session or a sign-in record — and never a token the result carries", async () => {
    provider.signIn.mockResolvedValue({
      success: false,
      mfaRequired: true,
      mfaSession: "s",
      // A provider that (wrongly) attaches tokens to a challenge: they do not pass through.
      accessToken: "leaked-access",
      refreshToken: "leaked-refresh",
      idToken: "leaked-id",
    });
    const res = await signIn(
      req("/api/auth/sign-in", { body: { email: "a@b.c", password: "p" } })
    );
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toEqual({
      success: false,
      mfaRequired: true,
      mfaSession: "s",
    });
    expect(await readable(res)).not.toMatch(/leaked/);
    expect(sessionCookieOf(res)).toBeNull();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("answers the MFA challenge for the user named, starts the session, and records it as an MFA sign-in", async () => {
    provider.respondToMfaChallenge.mockResolvedValue(signedIn);
    const res = await mfaChallenge(
      req("/api/auth/mfa-challenge", {
        body: { session: "s", code: "123456", username: "a@b.c" },
      })
    );
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toEqual({ success: true, userId: USER });
    expect(provider.respondToMfaChallenge).toHaveBeenCalledWith("s", "123456", "a@b.c");
    expect((await sessionOf(res)).method).toBe("mfa");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "login_success", details: { method: "mfa" } })
    );
  });

  it("a sign-in without a refresh token gets a session that ends with its access token", async () => {
    provider.signIn.mockResolvedValue({ ...signedIn, refreshToken: undefined });
    const res = await signIn(
      req("/api/auth/sign-in", { body: { email: "a@b.c", password: "p" } })
    );
    const record = await sessionOf(res);
    expect(openIdentity(record.sealedTokens, record.idHash).renewable).toBe(false);
  });
});

describe("POST /api/auth/session/migrate — a browser signed in before ADR-057 (TASK-214)", () => {
  const renewed = (userId = USER) =>
    provider.renewSession.mockResolvedValue({
      kind: "renewed",
      session: {
        userId,
        accessToken: "access-2",
        refreshToken: "refresh-1",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    });

  it("exchanges the legacy cookie for a server-side session: no new sign-in, no token answered", async () => {
    renewed();
    const res = await migrate(
      req("/api/auth/session/migrate", { cookie: legacyCookie(USER, "refresh-1") })
    );
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toEqual({
      success: true,
      userId: USER,
      migrated: true,
    });
    expect(provider.renewSession).toHaveBeenCalledWith("refresh-1", USER);
    expect(await readable(res)).not.toMatch(/access-2|refresh-1/);
    const record = await sessionOf(res);
    expect(record).toMatchObject({ subject: USER, method: "migrated" });
    // The legacy cookie is gone from the browser.
    expect(res.headers.getSetCookie().find((l) => l.startsWith("pf_refresh=;"))).toMatch(
      /Max-Age=0/i
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "login_success",
        details: { method: "migrated" },
      })
    );
  });

  it("no legacy cookie: nothing to migrate, and the provider is not asked", async () => {
    const res = await migrate(req("/api/auth/session/migrate"));
    expect(await res.json()).toEqual({ success: true, migrated: false });
    expect(sessionCookieOf(res)).toBeNull();
    expect(provider.renewSession).not.toHaveBeenCalled();
  });

  it.each([
    ["no MAC", `pf_refresh=${USER}.refresh-1`],
    ["a MAC of the wrong length", `pf_refresh=${USER}.${"A".repeat(42)}.refresh-1`],
    ["a made-up MAC", `pf_refresh=${USER}.${"A".repeat(43)}.refresh-1`],
    [
      "another user's id on a genuine cookie's MAC and token",
      legacyCookie(USER, "refresh-1").replace(USER, OTHER),
    ],
    [
      "another token on a genuine cookie's id and MAC",
      legacyCookie(USER, "refresh-1").replace(/refresh-1$/, "refresh-2"),
    ],
    [
      "a MAC under a key this deployment never held",
      legacyCookie(USER, "refresh-1", "x".repeat(48)),
    ],
    ["an oversized value", `pf_refresh=${USER}.${"A".repeat(43)}.${"r".repeat(9000)}`],
  ])(
    "hostile: %s is no cookie — refused without asking the provider",
    async (_name, cookie) => {
      renewed();
      const res = await migrate(req("/api/auth/session/migrate", { cookie }));
      expect(await res.json()).toEqual({ success: true, migrated: false });
      expect(sessionCookieOf(res)).toBeNull();
      expect(provider.renewSession).not.toHaveBeenCalled();
    }
  );

  it("a legacy cookie signed under the previous key still migrates; one under no configured key does not", async () => {
    renewed();
    process.env.REFRESH_COOKIE_KEY = "a-new-key-".padEnd(48, "n");
    process.env.REFRESH_COOKIE_KEY_PREVIOUS = PREVIOUS_KEY;
    const ok = await migrate(
      req("/api/auth/session/migrate", {
        cookie: legacyCookie(USER, "refresh-1", PREVIOUS_KEY),
      })
    );
    expect((await ok.json()).migrated).toBe(true);
    // The key retired (30 days after the deploy): legacy browsers sign in again.
    delete process.env.REFRESH_COOKIE_KEY;
    delete process.env.REFRESH_COOKIE_KEY_PREVIOUS;
    const none = await migrate(
      req("/api/auth/session/migrate", {
        cookie: legacyCookie(USER, "refresh-1", PREVIOUS_KEY),
      })
    );
    expect((await none.json()).migrated).toBe(false);
    expect(readLegacyRefreshCookie(legacyCookie(USER, "r").split("=")[1])).toBeNull();
  });

  it("the provider refuses the refresh token (revoked, expired): not migrated, cookies cleared", async () => {
    provider.renewSession.mockResolvedValue({ kind: "refused" });
    const res = await migrate(
      req("/api/auth/session/migrate", { cookie: legacyCookie(USER, "refresh-1") })
    );
    expect(await res.json()).toEqual({ success: true, migrated: false });
    expect(sessionCookieOf(res)).toBeNull();
    expect(res.headers.getSetCookie().join()).toMatch(/pf_refresh=;/);
  });

  it("the provider cannot answer: 503, and the legacy cookie is kept for the next load", async () => {
    provider.renewSession.mockResolvedValue({ kind: "unavailable" });
    const res = await migrate(
      req("/api/auth/session/migrate", { cookie: legacyCookie(USER, "refresh-1") })
    );
    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("hostile: a renewal that names another user than the cookie's is not used — no session for either", async () => {
    renewed(OTHER);
    const res = await migrate(
      req("/api/auth/session/migrate", { cookie: legacyCookie(USER, "refresh-1") })
    );
    expect(await res.json()).toEqual({ success: true, migrated: false });
    expect(sessionCookieOf(res)).toBeNull();
    for (const subject of [USER, OTHER]) {
      await expect(inTenant(() => getSessionStore().countLive(subject))).resolves.toBe(0);
    }
  });

  it.each([
    ["another site", { origin: "https://evil.example" }],
    ["no origin at all", { origin: "" }],
    ["a null origin", { origin: "null" }],
  ])(
    "hostile: called from %s it is refused, whatever cookie it carries",
    async (_name, headers) => {
      renewed();
      const request = req("/api/auth/session/migrate", {
        cookie: legacyCookie(USER, "refresh-1"),
        headers,
      });
      if (headers.origin === "") request.headers.delete("origin");
      const res = await migrate(request);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("auth.csrf_failed");
      expect(provider.renewSession).not.toHaveBeenCalled();
    }
  );

  it("answers a coded 500 when the provider throws", async () => {
    provider.renewSession.mockRejectedValue(new Error("boom"));
    const res = await migrate(
      req("/api/auth/session/migrate", { cookie: legacyCookie(USER, "refresh-1") })
    );
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("internal.error");
  });
});

describe("POST /api/auth/sign-out (ADR-057 D6; X-17, A-12)", () => {
  it("ends the session in its record, revokes its refresh token, clears the cookies, records it", async () => {
    const s = await startTestSession({
      subject: USER,
      token: "access-1",
      refreshToken: "r-1",
    });
    const other = await startTestSession({
      subject: USER,
      token: "access-1",
      refreshToken: "r-2",
    });
    const res = await signOut(req("/api/auth/sign-out", { headers: s.headers }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect((await recordOf(s.idHash))?.revokedReason).toBe("sign_out");
    // This sign-in only: the user's other session is untouched.
    expect((await recordOf(other.idHash))?.revokedAt).toBeUndefined();
    expect(provider.signOut).toHaveBeenCalledTimes(1);
    expect(provider.signOut).toHaveBeenCalledWith("", "r-1");
    expect(provider.signOutEverywhere).not.toHaveBeenCalled();
    const lines = res.headers.getSetCookie().join("\n");
    expect(lines).toMatch(/pf_session=;[^\n]*Max-Age=0/i);
    expect(lines).toMatch(/pf_refresh=;[^\n]*Max-Age=0/i);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "logout", actorId: USER, targetId: USER })
    );
  });

  it("the record ends the session even when the provider fails to revoke: the id is refused from then on", async () => {
    provider.signOut.mockRejectedValue(new Error("provider down"));
    const s = await startTestSession({
      subject: USER,
      token: "access-1",
      refreshToken: "r-1",
    });
    const res = await signOut(req("/api/auth/sign-out", { headers: s.headers }));
    expect(res.status).toBe(200);
    expect((await recordOf(s.idHash))?.revokedAt).toBeDefined();
    const again = await signOut(req("/api/auth/sign-out", { headers: s.headers }));
    expect(again.status).toBe(200);
    expect(provider.signOut).toHaveBeenCalledTimes(1);
  });

  it("the session cannot be ended in its record: a coded 500 — and the browser still stops claiming it", async () => {
    const s = await startTestSession({ subject: USER, token: "access-1" });
    const store = getSessionStore();
    store.revoke = async () => {
      throw new Error("database down");
    };
    const res = await signOut(req("/api/auth/sign-out", { headers: s.headers }));
    expect(res.status).toBe(500);
    expect(res.headers.getSetCookie().join()).toMatch(/pf_session=;/);
    expect(mockRecordAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "logout" })
    );
  });

  it("without a session there is nothing to end: success, cookies cleared, nothing recorded", async () => {
    const res = await signOut(req("/api/auth/sign-out"));
    expect(res.status).toBe(200);
    expect(provider.signOut).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("a guest's session is ended; no token of a guest goes to the auth provider, and no account is recorded", async () => {
    const g = await startTestSession({
      kind: "guest",
      subject: "guest_" + "a".repeat(32),
      token: "guest.abc.def",
    });
    const res = await signOut(req("/api/auth/sign-out", { headers: g.headers }));
    expect(res.status).toBe(200);
    expect((await recordOf(g.idHash))?.revokedReason).toBe("sign_out");
    expect(provider.signOut).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("a legacy browser's refresh cookie is revoked too — only when its MAC holds", async () => {
    const res = await signOut(
      req("/api/auth/sign-out", { cookie: legacyCookie(USER, "legacy-refresh") })
    );
    expect(res.status).toBe(200);
    expect(provider.signOut).toHaveBeenCalledWith("", "legacy-refresh");
    provider.signOut.mockClear();
    await signOut(
      req("/api/auth/sign-out", { cookie: `pf_refresh=${USER}.${"A".repeat(43)}.forged` })
    );
    expect(provider.signOut).not.toHaveBeenCalled();
  });

  it("an Authorization header is not read: a bearer signs no one out", async () => {
    const s = await startTestSession({ subject: USER, token: "access-1" });
    const res = await signOut(
      req("/api/auth/sign-out", { headers: { authorization: "Bearer access-1" } })
    );
    expect(res.status).toBe(200);
    expect((await recordOf(s.idHash))?.revokedAt).toBeUndefined();
    expect(provider.verifyToken).not.toHaveBeenCalled();
    expect(provider.signOut).not.toHaveBeenCalled();
  });
});

describe("MFA enrolment (A-9; ADR-057 D7)", () => {
  let session: TestSession;
  /** A request from USER's browser: its session holds the access token "access-1". */
  const asUser = (
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {}
  ) =>
    req(path, {
      ...options,
      headers: { ...session.headers, ...(options.headers ?? {}) },
    });
  beforeEach(async () => {
    session = await startTestSession({
      subject: USER,
      token: "access-1",
      refreshToken: "r-1",
    });
  });

  it.each([
    ["setup", () => mfaSetup(req("/api/auth/mfa/setup"))],
    [
      "verify",
      () => mfaVerify(req("/api/auth/mfa/verify", { body: { code: "123456" } })),
    ],
    ["disable", () => mfaDisable(req("/api/auth/mfa/disable"))],
  ])("[hostile:role] %s refuses an unauthenticated caller", async (_l, call) => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(provider.setupMfa).not.toHaveBeenCalled();
    expect(provider.verifyMfaSetup).not.toHaveBeenCalled();
    expect(provider.disableMfa).not.toHaveBeenCalled();
  });

  it.each([
    [
      "setup",
      (h: Record<string, string>) => mfaSetup(req("/api/auth/mfa/setup", { headers: h })),
    ],
    [
      "verify",
      (h: Record<string, string>) =>
        mfaVerify(req("/api/auth/mfa/verify", { headers: h, body: { code: "123456" } })),
    ],
    [
      "disable",
      (h: Record<string, string>) =>
        mfaDisable(req("/api/auth/mfa/disable", { headers: h })),
    ],
  ])(
    "hostile: %s from another site, or without the session's token, changes nothing",
    async (_l, call) => {
      const forged: Record<string, string>[] = [
        {
          cookie: session.cookie,
          origin: "https://evil.example",
          "x-csrf-token": session.csrfToken,
        },
        { cookie: session.cookie, origin: "http://localhost" },
      ];
      for (const headers of forged) {
        const res = await call(headers);
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe("auth.csrf_failed");
      }
      expect(provider.setupMfa).not.toHaveBeenCalled();
      expect(provider.verifyMfaSetup).not.toHaveBeenCalled();
      expect(provider.disableMfa).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["setup", () => mfaSetup, undefined],
    ["verify", () => mfaVerify, { code: "123456" }],
  ] as const)(
    "%s from a single sign-on session is refused as what it is — never as an invalid session, and nothing is sent to the provider",
    async (_name, route, body) => {
      const sso = await startTestSession({
        subject: USER,
        token: "access-sso",
        refreshToken: "r-sso",
        method: "sso",
      });
      provider.verifyToken.mockResolvedValue({
        sub: USER,
        email: "a@b.c",
        emailVerified: true,
        mfaEnabled: false,
        iat: 0,
        exp: 9_999_999_999,
      });
      const res = await route()(
        req(`/api/auth/mfa/x`, { headers: sso.headers, ...(body ? { body } : {}) })
      );
      // 403 with its own code: a 401 auth.token_invalid would make the page sign itself out.
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("auth.mfa_sso_managed");
      expect(provider.setupMfa).not.toHaveBeenCalled();
      expect(provider.verifyMfaSetup).not.toHaveBeenCalled();
      // The session is as it was.
      const record = await runWithTenant(
        { tenantId: DEFAULT_TENANT_ID, mode: "single" },
        () => getSessionStore().find(sso.idHash)
      );
      expect(record?.revokedAt).toBeUndefined();
    }
  );

  it("setup enrols with the session's own access token — its one use — and returns the secret, uncached", async () => {
    // A first enrolment: the account has no factor yet (re-enrolment needs a step-up,
    // __tests__/mfa-step-up.test.ts — TASK-194).
    provider.verifyToken.mockResolvedValue({
      sub: USER,
      email: "a@b.c",
      emailVerified: true,
      mfaEnabled: false,
      iat: 0,
      exp: 9_999_999_999,
    });
    provider.setupMfa.mockResolvedValue({
      success: true,
      secretCode: "SECRET",
      qrCodeUri: "otpauth://totp/x",
    });
    const res = await mfaSetup(asUser("/api/auth/mfa/setup"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      secretCode: "SECRET",
      qrCodeUri: "otpauth://totp/x",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(provider.setupMfa).toHaveBeenCalledWith("access-1");
  });

  it.each(["12345", "1234567", "abcdef", "", 123456, null])(
    "verify refuses the malformed code %p before the provider",
    async (code) => {
      const res = await mfaVerify(asUser("/api/auth/mfa/verify", { body: { code } }));
      expect(res.status).toBe(400);
      expect(provider.verifyMfaSetup).not.toHaveBeenCalled();
    }
  );

  it("verify turns MFA on, records it, moves the session to a new id and ends the account's other sessions", async () => {
    provider.verifyMfaSetup.mockResolvedValue({ success: true });
    const elsewhere = await startTestSession({
      subject: USER,
      token: "access-1",
      refreshToken: "r-elsewhere",
    });
    const someoneElse = await startTestSession({ subject: OTHER, token: "t" });
    const res = await mfaVerify(
      asUser("/api/auth/mfa/verify", { body: { code: "123456" } })
    );
    expect(res.status).toBe(200);
    expect(provider.verifyMfaSetup).toHaveBeenCalledWith("access-1", "123456");
    const body = await res.json();
    expect(body).toMatchObject({ success: true, mfaEnabled: true });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mfa_enabled", actorId: USER })
    );

    // A new id, with a new forgery token; the old id is ended.
    const cookie = sessionCookieOf(res)!;
    expect(cookie).not.toBe(session.cookie);
    const moved = await sessionOf(res);
    expect(moved).toMatchObject({ subject: USER, csrfToken: body.csrfToken });
    expect(body.csrfToken).not.toBe(session.csrfToken);
    expect((await recordOf(session.idHash))?.revokedReason).toBe("rotated");
    // The same tokens, bound to the new id; the old sign-in's refresh token is not revoked.
    expect(openForProvider(moved.sealedTokens, moved.idHash, "renewal")).toBe("r-1");
    expect(provider.signOut).not.toHaveBeenCalledWith("", "r-1");
    // A session opened before the factor existed does not outlive it.
    expect((await recordOf(elsewhere.idHash))?.revokedReason).toBe("factor_changed");
    expect(provider.signOut).toHaveBeenCalledWith("", "r-elsewhere");
    expect((await recordOf(someoneElse.idHash))?.revokedAt).toBeUndefined();
  });

  it("verify answers 503 when the change cannot be recorded", async () => {
    provider.verifyMfaSetup.mockResolvedValue({ success: true });
    mockRecordAudit.mockRejectedValueOnce(new Error("audit down"));
    const res = await mfaVerify(
      asUser("/api/auth/mfa/verify", { body: { code: "123456" } })
    );
    expect(res.status).toBe(503);
  });

  it("verify passes a wrong code's refusal on, coded, and the session stays as it is", async () => {
    provider.verifyMfaSetup.mockResolvedValue({
      success: false,
      error: "bad",
      errorCode: "auth.code_invalid",
    });
    const res = await mfaVerify(
      asUser("/api/auth/mfa/verify", { body: { code: "000000" } })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("auth.code_invalid");
    expect(sessionCookieOf(res)).toBeNull();
    expect((await recordOf(session.idHash))?.revokedAt).toBeUndefined();
  });

  it("disable turns MFA off by the session's subject (never its token), records it, and moves the session", async () => {
    // TASK-194, audit C-3: removing the factor needs proof of it — this asserted a token alone did.
    provider.confirmCurrentFactor.mockResolvedValue({ success: true });
    provider.disableMfa.mockResolvedValue({ success: true });
    const res = await mfaDisable(
      asUser("/api/auth/mfa/disable", { body: { password: "p", currentCode: "123456" } })
    );
    expect(res.status).toBe(200);
    expect(provider.confirmCurrentFactor).toHaveBeenCalledWith(USER, "p", "123456");
    expect(provider.disableMfa).toHaveBeenCalledWith(USER);
    expect(JSON.stringify(provider.disableMfa.mock.calls)).not.toContain("access-1");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mfa_disabled", actorId: USER })
    );
    expect(sessionCookieOf(res)).not.toBe(session.cookie);
    expect((await recordOf(session.idHash))?.revokedReason).toBe("rotated");
  });

  it("disable refused by the provider's administrative key answers the coded refusal, and nothing moves", async () => {
    provider.confirmCurrentFactor.mockResolvedValue({ success: true });
    provider.disableMfa.mockResolvedValue({
      success: false,
      error: "administrative key refused",
      errorCode: "service.unavailable",
      errorParams: { service: "auth" },
    });
    const res = await mfaDisable(
      asUser("/api/auth/mfa/disable", { body: { password: "p", currentCode: "123456" } })
    );
    expect(res.status).toBe(503);
    expect(sessionCookieOf(res)).toBeNull();
    expect((await recordOf(session.idHash))?.revokedAt).toBeUndefined();
    expect(mockRecordAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "mfa_disabled" })
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
        asUser("/api/auth/mfa/verify", {
          headers: { "x-forwarded-for": `198.51.100.${i}` },
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
