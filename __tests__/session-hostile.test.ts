/**
 * __tests__/session-hostile.test.ts — the server-side session under attack (ADR-057, TASK-214,
 * SEC-016)
 *
 * The real routes and the real guard, the real session module, the memory session store, and a
 * provider whose verification is the mock's (a token names the mock user or nobody). Each test
 * is something a hostile party does:
 *
 *   another tenant's session id          presented to this tenant's address
 *   a replayed id                        after sign-out; after sign-out everywhere
 *   a fixed id                           supplied before sign-in — a made-up one, and a real one
 *                                        of the attacker's own
 *   a cross-site POST                    the cookie rides along; no session token
 *   the right cookie and token           from the wrong origin, a `null` origin, no origin
 *   an expired session                   idle; absolute; a lifetime set to nothing
 *   an account restricted or erased      in the middle of its session
 *   concurrent renewal                   many requests on one expired access token
 *   a bearer credential                  on a user route
 *   a tampered record                    tokens that are not this session's; another subject's
 *
 * and what every answer must not contain: a token.
 */

import { NextRequest } from "next/server";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

const mockVerifyToken = jest.fn();
const mockRenewSession = jest.fn();
const mockSignOut = jest.fn();
const mockSignOutEverywhere = jest.fn();
jest.mock("@/platform/auth/config", () => {
  const { createMockAuthProvider } = jest.requireActual("@/platform/auth/mock-provider");
  const provider = createMockAuthProvider({
    verifyToken: (...a: unknown[]) => mockVerifyToken(...a),
    renewSession: (...a: unknown[]) => mockRenewSession(...a),
    signOut: (...a: unknown[]) => mockSignOut(...a),
    signOutEverywhere: (...a: unknown[]) => mockSignOutEverywhere(...a),
  });
  return {
    getAuthProvider: () => provider,
    hasAuthProvider: () => true,
    registerAuthProvider: jest.fn(),
  };
});
jest.mock("@/platform/auth/auth-init", () => ({ initAuth: jest.fn() }));

// Who is staff: the session module asks the permissions of the session's subject.
const mockPermissions = jest.fn();
jest.mock("@/platform/auth/permissions-cache", () => ({
  ...jest.requireActual("@/platform/auth/permissions-cache"),
  getCachedPermissions: (...a: unknown[]) => mockPermissions(...a),
}));
const mockConfigNumber = jest.fn();
jest.mock("@/platform/auth/platform-config", () => ({
  ...jest.requireActual("@/platform/auth/platform-config"),
  getConfigNumber: (...a: unknown[]) => mockConfigNumber(...a),
}));
// The account behind the mock user: resolved without a database.
jest.mock("@/platform/auth/account-identity", () => ({
  ...jest.requireActual("@/platform/auth/account-identity"),
  resolveAccountRecord: jest.fn(async (sub: string) => ({
    resolution: { kind: "bound", accountId: sub },
    address: undefined,
  })),
  auditableAccountId: jest.fn(async (sub: unknown) => sub),
}));
jest.mock("@/platform/tenancy/identity", () => ({
  ...jest.requireActual("@/platform/tenancy/identity"),
  sessionTenantRefusal: jest.fn(async () => null),
}));

import {
  DEFAULT_RULES,
  getRateLimiter,
  resetRateLimiter,
  setRateLimiter,
} from "@/platform/rate-limit";
import { GET as sessionGet, POST as sessionPost } from "@/app/api/auth/session/route";
import { POST as signIn } from "@/app/api/auth/sign-in/route";
import { POST as signOut } from "@/app/api/auth/sign-out/route";
import { POST as signOutEverywhere } from "@/app/api/auth/sign-out-everywhere/route";
import { POST as guest } from "@/app/api/auth/guest/route";
import { requireAuth as requireAuthInScope } from "@/platform/auth/middleware";
import {
  endSubjectSessions,
  hashSessionId,
  sessionCookieName,
} from "@/platform/auth/session";
import {
  MemorySessionStore,
  getSessionStore,
  setSessionStore,
} from "@/platform/auth/session-store";
import { sealTokens } from "@/platform/auth/session-vault";
import {
  DEFAULT_TENANT_ID,
  runRequestScope,
  runWithTenant,
} from "@/platform/tenancy/context";
import {
  MOCK_SUBJECT,
  TEST_ORIGIN,
  sessionCookieAttributes,
  sessionCookieOf,
  startTestSession,
} from "./helpers/session";

/** The guard as a route runs it: in a request's own tenant scope (platform/tenancy/route.ts). */
const requireAuth = (...args: Parameters<typeof requireAuthInScope>) =>
  runRequestScope(() => requireAuthInScope(...args));

const OTHER_TENANT = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const inDefault = <T>(fn: () => T): T =>
  runWithTenant({ tenantId: DEFAULT_TENANT_ID, mode: "single" }, fn);
const record = (idHash: string) => inDefault(() => getSessionStore().find(idHash));

function request(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): NextRequest {
  return new NextRequest(`${TEST_ORIGIN}${path}`, {
    method: options.method ?? "POST",
    headers: {
      "x-forwarded-for": "203.0.113.7",
      "user-agent": "jest",
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

const mockUser = {
  sub: MOCK_SUBJECT,
  email: "test@example.com",
  emailVerified: true,
  identityProviders: [],
  iat: 0,
  exp: 4_000_000_000,
  mfaEnabled: true,
};

/** A response body and headers, as text: what a browser's script could read. */
async function readable(response: Response): Promise<string> {
  const body = await response.clone().text();
  const headers = [...response.headers.entries()]
    .filter(([name]) => name !== "set-cookie")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `${headers}\n${body}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetRateLimiter();
  setSessionStore(new MemorySessionStore());
  mockVerifyToken.mockImplementation(async (token: string) =>
    token === "mock-access-token" || token === "renewed-access-token" ? mockUser : null
  );
  mockRenewSession.mockResolvedValue({ kind: "refused" });
  mockSignOut.mockResolvedValue(undefined);
  mockSignOutEverywhere.mockResolvedValue({ success: true });
  mockPermissions.mockResolvedValue({ permissions: [] });
  mockConfigNumber.mockImplementation(async (_key: string, fallback: number) => fallback);
});

describe("the baseline: a session works for its own browser", () => {
  it("a read needs only the cookie; a change needs this origin and the session's token", async () => {
    const s = await startTestSession();
    const read = await sessionGet(
      request("/api/auth/session", { method: "GET", headers: { cookie: s.cookie } })
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      authenticated: true,
      user: { userId: MOCK_SUBJECT, isGuest: false },
      csrfToken: s.csrfToken,
      audience: "user",
    });
    const change = await sessionPost(
      request("/api/auth/session", { headers: s.headers })
    );
    expect(change.status).toBe(200);
  });
});

describe("the page's read of its session is counted per session, not per address (AUTH_SESSION_STATUS)", () => {
  const status = (cookie?: string) =>
    sessionGet(
      request("/api/auth/session", {
        method: "GET",
        headers: cookie ? { cookie } : {},
      })
    );

  it("many signed-in people behind one address each load pages: none is refused for the others' reads", async () => {
    // Forty people, one address (an office, a school), one page load each within the minute —
    // more than the 30 a per-address count of the session routes allows.
    const people = await Promise.all(
      Array.from({ length: 40 }, () => startTestSession())
    );
    for (const person of people) {
      const read = await status(person.cookie);
      expect(read.status).toBe(200);
      expect(((await read.json()) as { authenticated: boolean }).authenticated).toBe(
        true
      );
    }
  });

  it("hostile: one session reading without pause is refused past its own limit — and only it", async () => {
    const greedy = await startTestSession();
    const other = await startTestSession();
    const limit = DEFAULT_RULES.AUTH_SESSION_STATUS.maxRequests;
    for (let i = 0; i < limit; i++)
      expect((await status(greedy.cookie)).status).toBe(200);
    const refused = await status(greedy.cookie);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { code: string }).code).toBe("rate.limited");
    expect((await status(other.cookie)).status).toBe(200);
  });

  it("hostile: a request naming no session — or a value that is no session id — is counted by its address", async () => {
    const limit = DEFAULT_RULES.AUTH_SESSION_STATUS.maxRequests;
    const malformed = `${sessionCookieName()}=not-a-session-id`;
    for (let i = 0; i < limit; i++) {
      const read = await status(i % 2 === 0 ? undefined : malformed);
      expect(read.status).toBe(200);
      expect(((await read.json()) as { authenticated: boolean }).authenticated).toBe(
        false
      );
    }
    expect((await status()).status).toBe(429);
    expect((await status(malformed)).status).toBe(429);
    // A signed-in person at that address is not refused with them.
    const person = await startTestSession();
    expect((await status(person.cookie)).status).toBe(200);
  });

  it("the count's key is the cookie's hash, never the session id itself", async () => {
    const seen: string[] = [];
    const real = getRateLimiter();
    setRateLimiter({
      name: "spy",
      check: (identifier, rule) => {
        seen.push(identifier);
        return real.check(identifier, rule);
      },
      peek: (identifier, rule) => real.peek(identifier, rule),
      reset: (identifier, rule) => real.reset(identifier, rule),
    });
    const s = await startTestSession();
    await status(s.cookie);
    expect(seen.join("\n")).toContain(`session:${s.idHash}`);
    expect(seen.join("\n")).not.toContain(s.id);
  });
});

describe("another tenant's session id", () => {
  it("presented to this tenant's address is no session — and is not ended in its own tenant", async () => {
    const stolen = await startTestSession({ tenantId: OTHER_TENANT });
    const res = await sessionPost(
      request("/api/auth/session", { headers: stolen.headers })
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth.token_invalid");
    const there = await runWithTenant({ tenantId: OTHER_TENANT, mode: "shared" }, () =>
      getSessionStore().find(stolen.idHash)
    );
    expect(there?.revokedAt).toBeUndefined();
    expect(await record(stolen.idHash)).toBeNull();
  });
});

describe("a replayed session id", () => {
  it("after sign-out finds a revoked record, on a read and on a change", async () => {
    const s = await startTestSession({ refreshToken: "refresh-1" });
    const out = await signOut(request("/api/auth/sign-out", { headers: s.headers }));
    expect(out.status).toBe(200);
    expect(sessionCookieOf(out)).toBeNull();
    expect((await record(s.idHash))?.revokedReason).toBe("sign_out");
    // The refresh token went to the provider for revocation; no access token did.
    expect(mockSignOut).toHaveBeenCalledWith("", "refresh-1");

    const read = await sessionGet(
      request("/api/auth/session", { method: "GET", headers: { cookie: s.cookie } })
    );
    expect(await read.json()).toEqual({ authenticated: false });
    const replay = await signOutEverywhere(
      request("/api/auth/sign-out-everywhere", { headers: s.headers })
    );
    expect(replay.status).toBe(401);
    const guard = await requireAuth(request("/api/x", { headers: s.headers }));
    expect(guard.error?.status).toBe(401);
  });

  it("after sign-out everywhere, every session of the account is ended — the others' ids too", async () => {
    const here = await startTestSession({ refreshToken: "refresh-here" });
    const phone = await startTestSession({ refreshToken: "refresh-phone" });
    const someoneElse = await startTestSession({ subject: "another-user" });
    const res = await signOutEverywhere(
      request("/api/auth/sign-out-everywhere", { headers: here.headers })
    );
    expect(await res.json()).toEqual({
      success: true,
      sessionsEnded: 2,
      providerSignedOut: true,
    });
    expect(mockSignOutEverywhere).toHaveBeenCalledWith(MOCK_SUBJECT);
    for (const s of [here, phone]) {
      expect((await record(s.idHash))?.revokedReason).toBe("sign_out_everywhere");
      const guard = await requireAuth(
        request("/api/x", { method: "GET", headers: { cookie: s.cookie } })
      );
      expect(guard.error?.status).toBe(401);
    }
    expect((await record(someoneElse.idHash))?.revokedAt).toBeUndefined();
  });

  it("sign-out everywhere still ends the platform's sessions when the provider's key lacks the action", async () => {
    mockSignOutEverywhere.mockResolvedValue({
      success: false,
      errorCode: "service.unavailable",
    });
    const s = await startTestSession();
    const res = await signOutEverywhere(
      request("/api/auth/sign-out-everywhere", { headers: s.headers })
    );
    expect(await res.json()).toEqual({
      success: true,
      sessionsEnded: 1,
      providerSignedOut: false,
    });
    expect((await record(s.idHash))?.revokedAt).toBeDefined();
  });
});

describe("a fixed session id (supplied before sign-in)", () => {
  const credentials = { email: "test@example.com", password: "correct-horse" };

  it("a made-up id is not adopted: sign-in issues its own", async () => {
    const planted = "A".repeat(43);
    const res = await signIn(
      request("/api/auth/sign-in", {
        body: credentials,
        headers: { cookie: `${sessionCookieName()}=${planted}`, origin: TEST_ORIGIN },
      })
    );
    expect(res.status).toBe(200);
    const issued = sessionCookieOf(res)!;
    expect(issued).not.toBe(`${sessionCookieName()}=${planted}`);
    expect(await record(hashSessionId(planted))).toBeNull();
    // The attacker, holding the id they planted, has no session.
    const attacker = await requireAuth(
      request("/api/x", {
        method: "GET",
        headers: { cookie: `${sessionCookieName()}=${planted}` },
      })
    );
    expect(attacker.error?.status).toBe(401);
  });

  it("[hostile:self] the attacker's own live session, planted in the victim's browser, is ended — the victim gets a new id", async () => {
    const attackers = await startTestSession({
      subject: "attacker-sub",
      token: "attacker",
    });
    const res = await signIn(
      request("/api/auth/sign-in", {
        body: credentials,
        headers: { cookie: attackers.cookie, origin: TEST_ORIGIN },
      })
    );
    expect(res.status).toBe(200);
    const issued = sessionCookieOf(res)!;
    expect(issued).not.toBe(attackers.cookie);
    expect((await record(attackers.idHash))?.revokedReason).toBe("rotated");
    const victims = await record(hashSessionId(issued.split("=")[1]));
    expect(victims?.subject).toBe(MOCK_SUBJECT);
  });

  it("two sign-ins never share an id, and the cookie is HttpOnly, SameSite=Lax, Path=/, no Domain", async () => {
    const one = await signIn(request("/api/auth/sign-in", { body: credentials }));
    const two = await signIn(request("/api/auth/sign-in", { body: credentials }));
    expect(sessionCookieOf(one)).not.toBe(sessionCookieOf(two));
    const attrs = sessionCookieAttributes(one)!;
    expect(attrs.httponly).toBe("true");
    expect(attrs.samesite).toBe("lax");
    expect(attrs.path).toBe("/");
    expect(attrs.domain).toBeUndefined();
    expect(Number(attrs["max-age"])).toBe(30 * 86400);
  });

  it("a sign-in answers no token — in its body, its headers, or a readable cookie", async () => {
    const res = await signIn(request("/api/auth/sign-in", { body: credentials }));
    expect(await res.clone().json()).toEqual({ success: true, userId: MOCK_SUBJECT });
    const text = await readable(res);
    expect(text).not.toMatch(
      /mock-access-token|mock-refresh-token|accessToken|refreshToken|idToken/
    );
    for (const line of res.headers.getSetCookie()) {
      if (/Max-Age=0/i.test(line)) continue; // a legacy cookie being cleared
      expect(line).toMatch(/HttpOnly/i);
      expect(line).not.toMatch(/mock-access-token|mock-refresh-token/);
    }
  });
});

describe("a cross-site request", () => {
  const cases: Array<
    [string, (s: { cookie: string; csrfToken: string }) => Record<string, string>]
  > = [
    [
      "the cookie alone (what a cross-site form sends when SameSite does not stop it)",
      (s) => ({ cookie: s.cookie, origin: "https://evil.example" }),
    ],
    [
      "the cookie and this origin, without the token",
      (s) => ({ cookie: s.cookie, origin: TEST_ORIGIN }),
    ],
    [
      "the cookie and this origin, with another session's token",
      (s) => ({ cookie: s.cookie, origin: TEST_ORIGIN, "x-csrf-token": "B".repeat(43) }),
    ],
    [
      "the right cookie and the right token from another origin",
      (s) => ({
        cookie: s.cookie,
        origin: "https://evil.example",
        "x-csrf-token": s.csrfToken,
      }),
    ],
    [
      "the right cookie and token from a sibling subdomain (same site, another origin)",
      (s) => ({
        cookie: s.cookie,
        origin: "http://app.localhost",
        "x-csrf-token": s.csrfToken,
      }),
    ],
    [
      "the right cookie and token from the same host on another scheme",
      (s) => ({
        cookie: s.cookie,
        origin: "https://localhost",
        "x-csrf-token": s.csrfToken,
      }),
    ],
    [
      "the right cookie and token with Origin: null (a sandboxed frame, a redirect)",
      (s) => ({ cookie: s.cookie, origin: "null", "x-csrf-token": s.csrfToken }),
    ],
    [
      "the right cookie and token with no Origin and no Referer",
      (s) => ({ cookie: s.cookie, "x-csrf-token": s.csrfToken }),
    ],
    [
      "the right cookie and token with only a cross-site Referer",
      (s) => ({
        cookie: s.cookie,
        referer: "https://evil.example/page",
        "x-csrf-token": s.csrfToken,
      }),
    ],
    [
      "an origin that only starts like ours",
      (s) => ({
        cookie: s.cookie,
        origin: "http://localhost.evil.example",
        "x-csrf-token": s.csrfToken,
      }),
    ],
  ];

  it.each(cases)("%s is refused, and nothing changes", async (_name, headers) => {
    const s = await startTestSession({ lastSeenAt: Date.now() - 10 * 60_000 });
    const before = await record(s.idHash);
    for (const handler of [sessionPost, signOut, signOutEverywhere]) {
      const res = await handler(request("/api/auth/x", { headers: headers(s) }));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("auth.csrf_failed");
      // The victim's cookie is not cleared by an attacker's request.
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    // Not signed out, not kept alive, nothing revoked at the provider.
    expect(await record(s.idHash)).toEqual(before);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignOutEverywhere).not.toHaveBeenCalled();
  });

  it("a same-origin Referer stands in for a missing Origin", async () => {
    const s = await startTestSession();
    const res = await sessionPost(
      request("/api/auth/session", {
        headers: {
          cookie: s.cookie,
          referer: `${TEST_ORIGIN}/admin`,
          "x-csrf-token": s.csrfToken,
        },
      })
    );
    expect(res.status).toBe(200);
  });

  it("a cross-site request cannot replace a user's session with a guest's (login forgery)", async () => {
    const s = await startTestSession();
    const res = await guest(
      request("/api/auth/guest", {
        headers: { cookie: s.cookie, origin: "https://evil.example" },
      })
    );
    expect(res.status).toBe(403);
    expect(sessionCookieOf(res)).toBeNull();
    expect((await record(s.idHash))?.revokedAt).toBeUndefined();
  });

  it("the token of one session does not work with another's cookie", async () => {
    const a = await startTestSession();
    const b = await startTestSession();
    const res = await sessionPost(
      request("/api/auth/session", {
        headers: { cookie: a.cookie, origin: TEST_ORIGIN, "x-csrf-token": b.csrfToken },
      })
    );
    expect(res.status).toBe(403);
  });
});

describe("an expired session", () => {
  const minutes = (n: number) => n * 60_000;

  it("a staff session idle past 30 minutes is ended, in its record, with why", async () => {
    mockPermissions.mockResolvedValue({ permissions: ["can_access_admin"] });
    const s = await startTestSession({
      createdAt: Date.now() - minutes(40),
      lastSeenAt: Date.now() - minutes(31),
      refreshToken: "refresh-idle",
    });
    const guard = await requireAuth(
      request("/api/x", { method: "GET", headers: { cookie: s.cookie } })
    );
    expect(guard.error?.status).toBe(401);
    expect((await guard.error!.json()).code).toBe("auth.token_invalid");
    // The browser is told to drop the cookie.
    expect(guard.error!.headers.getSetCookie().join()).toMatch(/Max-Age=0/i);
    expect((await record(s.idHash))?.revokedReason).toBe("idle_timeout");
    expect(mockSignOut).toHaveBeenCalledWith("", "refresh-idle");
    // And stays ended: the same id a moment later.
    const again = await requireAuth(request("/api/x", { headers: s.headers }));
    expect(again.error?.status).toBe(401);
  });

  it("the same idle time is nothing to a user (7 days), and a user idle 8 days is ended", async () => {
    const recent = await startTestSession({ lastSeenAt: Date.now() - minutes(31) });
    const ok = await requireAuth(
      request("/api/x", { method: "GET", headers: { cookie: recent.cookie } })
    );
    expect(ok.error).toBeUndefined();
    const stale = await startTestSession({
      createdAt: Date.now() - 9 * 86_400_000,
      lastSeenAt: Date.now() - 8 * 86_400_000,
    });
    const refused = await requireAuth(
      request("/api/x", { method: "GET", headers: { cookie: stale.cookie } })
    );
    expect(refused.error?.status).toBe(401);
    expect((await record(stale.idHash))?.revokedReason).toBe("idle_timeout");
  });

  it("a staff session used every minute still ends 12 hours after sign-in", async () => {
    mockPermissions.mockResolvedValue({ permissions: ["admin_manage_users"] });
    const s = await startTestSession({
      createdAt: Date.now() - (12 * 60 + 1) * 60_000,
      lastSeenAt: Date.now() - 1000,
    });
    const guard = await requireAuth(
      request("/api/x", { method: "GET", headers: { cookie: s.cookie } })
    );
    expect(guard.error?.status).toBe(401);
    expect((await record(s.idHash))?.revokedReason).toBe("absolute_timeout");
  });

  it("[hostile:store-down] permissions that cannot be read give the shorter (staff) lifetimes, never the longer", async () => {
    mockPermissions.mockRejectedValue(new Error("database down"));
    const s = await startTestSession({ lastSeenAt: Date.now() - minutes(31) });
    const guard = await requireAuth(
      request("/api/x", { method: "GET", headers: { cookie: s.cookie } })
    );
    expect(guard.error?.status).toBe(401);
  });

  it.each([0, -5, Number.NaN, 1e15])(
    "an idle setting of %p does not make a session that never ends, or one that cannot start",
    async (value) => {
      mockConfigNumber.mockResolvedValue(value);
      const live = await startTestSession({ lastSeenAt: Date.now() - minutes(5) });
      const ok = await requireAuth(
        request("/api/x", { method: "GET", headers: { cookie: live.cookie } })
      );
      expect(ok.error).toBeUndefined();
      const old = await startTestSession({
        createdAt: Date.now() - 91 * 86_400_000,
        lastSeenAt: Date.now() - 1000,
      });
      const refused = await requireAuth(
        request("/api/x", { method: "GET", headers: { cookie: old.cookie } })
      );
      expect(refused.error?.status).toBe(401);
    }
  );

  it('reading the session\'s status does not keep it alive; "stay signed in" does', async () => {
    mockPermissions.mockResolvedValue({ permissions: ["can_access_admin"] });
    const lastSeenAt = Date.now() - minutes(29);
    const s = await startTestSession({ lastSeenAt });
    for (let i = 0; i < 3; i += 1) {
      const res = await sessionGet(
        request("/api/auth/session", { method: "GET", headers: { cookie: s.cookie } })
      );
      const body = await res.json();
      expect(body.audience).toBe("staff");
      expect(body.idleExpiresAt).toBe(lastSeenAt + minutes(30));
    }
    expect((await record(s.idHash))?.lastSeenAt).toBe(lastSeenAt);
    const stay = await sessionPost(request("/api/auth/session", { headers: s.headers }));
    const stayed = await stay.json();
    expect(stayed.idleExpiresAt).toBeGreaterThan(Date.now() + minutes(29));
    expect((await record(s.idHash))?.lastSeenAt).toBeGreaterThan(lastSeenAt);
  });
});

describe("an account restricted or erased in the middle of its session", () => {
  it.each([
    ["suspended or banned", "account_restricted"],
    ["erased", "account_erased"],
    ["given another role", "role_changed"],
  ] as const)(
    "%s: every session ends at once, and the provider is asked to end its tokens",
    async (_what, reason) => {
      const laptop = await startTestSession({ refreshToken: "r-laptop" });
      const phone = await startTestSession({ refreshToken: "r-phone" });
      const working = await requireAuth(request("/api/x", { headers: laptop.headers }));
      expect(working.error).toBeUndefined();

      await inDefault(() => endSubjectSessions(MOCK_SUBJECT, reason));

      for (const s of [laptop, phone]) {
        const guard = await requireAuth(request("/api/x", { headers: s.headers }));
        expect(guard.error?.status).toBe(401);
        expect((await record(s.idHash))?.revokedReason).toBe(reason);
      }
      expect(mockSignOut.mock.calls.map((c) => c[1]).sort()).toEqual([
        "r-laptop",
        "r-phone",
      ]);
      expect(mockSignOutEverywhere).toHaveBeenCalledWith(MOCK_SUBJECT);
    }
  );

  it("ending an account's sessions never throws, whatever fails", async () => {
    const broken = new MemorySessionStore();
    broken.revokeSubject = async () => {
      throw new Error("database down");
    };
    setSessionStore(broken);
    await expect(
      endSubjectSessions(MOCK_SUBJECT, "account_restricted")
    ).resolves.toBeUndefined();
    await expect(endSubjectSessions(null, "account_erased")).resolves.toBeUndefined();
  });

  it("a user the provider no longer vouches for (deleted, disabled) is refused though the record is live", async () => {
    const s = await startTestSession();
    mockVerifyToken.mockResolvedValue(null);
    const guard = await requireAuth(request("/api/x", { headers: s.headers }));
    expect(guard.error?.status).toBe(401);
    const read = await sessionGet(
      request("/api/auth/session", { method: "GET", headers: { cookie: s.cookie } })
    );
    expect(await read.json()).toEqual({ authenticated: false });
  });
});

describe("concurrent renewal", () => {
  const expired = () => Math.floor(Date.now() / 1000) - 5;
  const renewed = () => ({
    kind: "renewed" as const,
    session: {
      userId: MOCK_SUBJECT,
      accessToken: "renewed-access-token",
      refreshToken: "refresh-1",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
  });

  it("many requests on one expired access token make one exchange, and all are served", async () => {
    mockVerifyToken.mockImplementation(async (token: string) =>
      token === "renewed-access-token" ? mockUser : null
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockRenewSession.mockImplementation(async () => {
      await gate;
      return renewed();
    });
    const s = await startTestSession({
      token: "expired-access-token",
      refreshToken: "refresh-1",
      tokenExpiresAt: expired(),
    });
    const pending = Array.from({ length: 8 }, () =>
      requireAuth(request("/api/x", { method: "GET", headers: { cookie: s.cookie } }))
    );
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await Promise.all(pending);
    expect(results).toHaveLength(8);
    expect(results.every((r) => r.error === undefined)).toBe(true);
    expect(mockRenewSession).toHaveBeenCalledTimes(1);
    expect(mockRenewSession).toHaveBeenCalledWith("refresh-1", MOCK_SUBJECT);
    expect((await record(s.idHash))?.tokenVersion).toBe(2);
    // The next request uses what was stored: no second exchange.
    const next = await requireAuth(
      request("/api/x", { method: "GET", headers: { cookie: s.cookie } })
    );
    expect(next.error).toBeUndefined();
    expect(mockRenewSession).toHaveBeenCalledTimes(1);
  });

  it("a refused renewal ends the session; the provider not answering does not", async () => {
    mockRenewSession.mockResolvedValue({ kind: "unavailable" });
    const s = await startTestSession({
      token: "expired-access-token",
      refreshToken: "refresh-1",
      tokenExpiresAt: expired(),
    });
    const down = await requireAuth(
      request("/api/x", { method: "GET", headers: { cookie: s.cookie } })
    );
    expect(down.error?.status).toBe(503);
    expect((await record(s.idHash))?.revokedAt).toBeUndefined();

    mockRenewSession.mockResolvedValue({ kind: "refused" });
    const refused = await requireAuth(
      request("/api/x", { method: "GET", headers: { cookie: s.cookie } })
    );
    expect(refused.error?.status).toBe(401);
    expect((await record(s.idHash))?.revokedReason).toBe("provider_refused");
  });

  it("a renewal that names another user is not the session's (the provider's answer is checked)", async () => {
    mockRenewSession.mockResolvedValue(renewed());
    mockVerifyToken.mockResolvedValue({ ...mockUser, sub: "someone-else" });
    const s = await startTestSession({
      token: "expired-access-token",
      refreshToken: "refresh-1",
      tokenExpiresAt: expired(),
    });
    const guard = await requireAuth(
      request("/api/x", { method: "GET", headers: { cookie: s.cookie } })
    );
    expect(guard.error?.status).toBe(401);
  });

  it("a session ended while its renewal was in flight stays ended", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockRenewSession.mockImplementation(async () => {
      await gate;
      return renewed();
    });
    const s = await startTestSession({
      token: "expired-access-token",
      refreshToken: "refresh-1",
      tokenExpiresAt: expired(),
    });
    const pending = requireAuth(
      request("/api/x", { method: "GET", headers: { cookie: s.cookie } })
    );
    await new Promise((r) => setTimeout(r, 20));
    await inDefault(() => getSessionStore().revoke(s.idHash, "sign_out", Date.now()));
    release();
    expect((await pending).error?.status).toBe(401);
    const stored = await record(s.idHash);
    expect(stored?.revokedReason).toBe("sign_out");
    expect(stored?.tokenVersion).toBe(1);
  });
});

describe("a bearer credential on a user route", () => {
  it.each(["mock-access-token", "guest.abc.def", "test-token"])(
    "Authorization: Bearer %s is not a session",
    async (token) => {
      const guard = await requireAuth(
        request("/api/x", {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
        })
      );
      expect(guard.error?.status).toBe(401);
      expect((await guard.error!.json()).code).toBe("auth.required");
      expect(mockVerifyToken).not.toHaveBeenCalled();
    }
  );

  it("a bearer beside a live session changes nothing: the session decides", async () => {
    const s = await startTestSession();
    const guard = await requireAuth(
      request("/api/x", {
        method: "GET",
        headers: { cookie: s.cookie, authorization: "Bearer someone-elses-token" },
      })
    );
    expect(guard.user?.sub).toBe(MOCK_SUBJECT);
    expect(mockVerifyToken).toHaveBeenCalledTimes(1);
    expect(mockVerifyToken.mock.calls[0][0]).toBe("mock-access-token");
  });
});

describe("a tampered record or cookie", () => {
  it("a session whose tokens name another user is not believed", async () => {
    const s = await startTestSession({ subject: "victim-sub" });
    // The held token verifies as the mock user, not as the session's subject.
    const guard = await requireAuth(
      request("/api/x", { method: "GET", headers: { cookie: s.cookie } })
    );
    expect(guard.error?.status).toBe(401);
  });

  it("sealed tokens copied from another session's row do not open, and the session is ended", async () => {
    const a = await startTestSession();
    const b = await startTestSession({ subject: "user-b", token: "b-token" });
    const store = getSessionStore();
    const rowA = (await record(a.idHash))!;
    const rowB = (await record(b.idHash))!;
    await inDefault(() =>
      store.replaceTokens(b.idHash, rowB.tokenVersion, rowA.sealedTokens)
    );
    const guard = await requireAuth(
      request("/api/x", { method: "GET", headers: { cookie: b.cookie } })
    );
    expect(guard.error?.status).toBe(401);
    expect((await record(b.idHash))?.revokedReason).toBe("unreadable");
  });

  it.each([
    "short",
    "A".repeat(42),
    "A".repeat(44),
    `${"A".repeat(42)}=`,
    `${"A".repeat(40)}%00a`,
    "../../etc/passwd",
    "' or 1=1 --",
  ])(
    "[hostile:id-spelling] a cookie value of %p is no session and reaches no store",
    async (value) => {
      const store = new MemorySessionStore();
      const find = jest.spyOn(store, "find");
      setSessionStore(store);
      const guard = await requireAuth(
        request("/api/x", {
          method: "GET",
          headers: { cookie: `${sessionCookieName()}=${value}` },
        })
      );
      expect(guard.error?.status).toBe(401);
      expect(find).not.toHaveBeenCalled();
    }
  );

  it("the id is stored only as a hash: the store's contents present nothing", async () => {
    const s = await startTestSession();
    const row = (await record(s.idHash))!;
    expect(JSON.stringify(row)).not.toContain(s.id);
    expect(row.idHash).toBe(hashSessionId(s.id));
    expect(row.sealedTokens).not.toContain("mock-access-token");
    // Presenting the hash itself as the cookie is not the session.
    const guard = await requireAuth(
      request("/api/x", {
        method: "GET",
        headers: { cookie: `${sessionCookieName()}=${row.idHash.slice(0, 43)}` },
      })
    );
    expect(guard.error?.status).toBe(401);
  });

  it("[hostile:role] a guest's session is not a user's", async () => {
    const g = await startTestSession({
      kind: "guest",
      subject: "guest_" + "a".repeat(32),
      token: sealTokens.name,
    });
    const guard = await requireAuth(
      request("/api/x", { method: "GET", headers: { cookie: g.cookie } })
    );
    expect(guard.error?.status).toBe(401);
    expect((await guard.error!.json()).code).toBe("auth.sign_in_required");
  });
});
