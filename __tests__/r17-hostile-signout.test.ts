/**
 * __tests__/r17-hostile-signout.test.ts — review 17 M1, the reviewer's proofs kept as regression
 * tests: sign-out revokes and records only a subject the provider proved, never the refresh
 * cookie's say-so, and the cookie is tamper-evident (an HMAC binds its user id to its token).
 *
 * Hostile cases: an attacker's own refresh token behind a victim's id (unsigned, the format before
 * the MAC, or a real MAC with the id swapped), a MAC-valid cookie whose refresh the provider does
 * not prove for its id, and a bearer of user A with a cookie naming B. Legitimate sign-outs (bearer
 * and cookie of one user; the cookie alone) still revoke and record that user.
 */

import { NextRequest } from "next/server";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

const provider: Record<string, jest.Mock | undefined> & {
  signOut: jest.Mock;
  refreshToken: jest.Mock;
  verifyToken: jest.Mock;
  signIn: jest.Mock;
} = {
  signIn: jest.fn(),
  signOut: jest.fn(),
  refreshToken: jest.fn(),
  verifyToken: jest.fn(),
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

import { resetRateLimiter } from "@/platform/rate-limit";
import { POST as signOut } from "@/app/api/auth/sign-out/route";
import { POST as refresh } from "@/app/api/auth/refresh/route";
import { POST as signIn } from "@/app/api/auth/sign-in/route";
import { createAuthPoolShapeProbe } from "@/platform/auth/pool-shape-probe";
import { refreshCookieValue } from "@/platform/auth/auth-response";
import * as tv from "@/platform/auth/token-verification";

const VICTIM = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f01234567";
const ATTACKER = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const A = "aaaaaaaa-1111-4111-8111-111111111111";

function req(
  path: string,
  options: { headers?: Record<string, string>; cookie?: string; body?: unknown } = {}
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

/** An access token naming `sub` (its claims; the provider mock verifies by them). */
const tokenOf = (sub: string) =>
  `x.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.y`;

const logoutRecord = () =>
  mockRecordAudit.mock.calls
    .map((c) => c[0] as { action: string; actorId?: string; targetId?: string })
    .find((r) => r.action === "logout");

let revoke: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  resetRateLimiter();
  mockHasDatabase.mockReturnValue(true);
  mockRecordAudit.mockResolvedValue(undefined);
  provider.signOut.mockResolvedValue(undefined);
  provider.refreshToken.mockResolvedValue(null);
  // The provider proves a token's own subject: what its claims say, for a token it issued.
  provider.verifyToken.mockImplementation(async (token: string) => {
    const sub = tv.tokenSubject(token);
    return sub ? { sub, email: "", emailVerified: false, iat: 0, exp: 9e9 } : null;
  });
  revoke = jest.spyOn(tv, "revokeTokenVerification");
});
afterEach(() => revoke.mockRestore());

describe("review 17 M1: a forged refresh cookie is no cookie", () => {
  it.each([
    ["unsigned (the reviewer's proof)", `${VICTIM}.attackers-own-refresh`],
    [
      "the attacker's own signed cookie with the victim's id swapped in",
      refreshCookieValue(ATTACKER, "attackers-own-refresh")!.replace(ATTACKER, VICTIM),
    ],
    ["a made-up MAC", `${VICTIM}.${"A".repeat(43)}.attackers-own-refresh`],
  ])(
    "%s: nothing revoked or voided for the victim, the logout not recorded as theirs",
    async (_label, cookie) => {
      const res = await signOut(
        req("/api/auth/sign-out", { cookie: `pf_refresh=${cookie}` })
      );
      expect(res.status).toBe(200);
      expect(provider.signOut).not.toHaveBeenCalled();
      expect(provider.refreshToken).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(logoutRecord()?.actorId).toBeUndefined();
      expect(JSON.stringify(mockRecordAudit.mock.calls)).not.toContain(VICTIM);
      expect(res.headers.get("set-cookie")).toMatch(/pf_refresh=;.*Max-Age=0/i);
    }
  );

  it("the refresh route refuses the same forgeries without asking the provider", async () => {
    for (const cookie of [
      `${VICTIM}.attackers-own-refresh`,
      refreshCookieValue(ATTACKER, "r")!.replace(ATTACKER, VICTIM),
    ]) {
      const res = await refresh(
        req("/api/auth/refresh", { cookie: `pf_refresh=${cookie}` })
      );
      expect(res.status).toBe(401);
    }
    expect(provider.refreshToken).not.toHaveBeenCalled();
  });

  it("a MAC-valid cookie whose refresh the provider proves for another user (or not at all) voids and records nobody", async () => {
    const cookie = `pf_refresh=${refreshCookieValue(VICTIM, "refresh-v")}`;
    for (const session of [
      null,
      { userId: ATTACKER, accessToken: "minted", refreshToken: "r", expiresAt: 0 },
      { userId: VICTIM, accessToken: "", refreshToken: "r", expiresAt: 0 },
    ]) {
      jest.clearAllMocks();
      provider.refreshToken.mockResolvedValueOnce(session);
      const res = await signOut(req("/api/auth/sign-out", { cookie }));
      expect(res.status).toBe(200);
      expect(provider.signOut).toHaveBeenCalledWith("", "refresh-v");
      expect(revoke).not.toHaveBeenCalled();
      expect(logoutRecord()?.actorId).toBeUndefined();
    }
    provider.refreshToken.mockRejectedValueOnce(new Error("provider threw"));
    jest.clearAllMocks();
    await signOut(req("/api/auth/sign-out", { cookie }));
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("review 17 M1: only the proven subject is revoked and recorded", () => {
  it("bearer is user A, cookie names B: A is revoked and recorded, never B", async () => {
    const tokenA = tokenOf(A);
    const res = await signOut(
      req("/api/auth/sign-out", {
        headers: { authorization: `Bearer ${tokenA}` },
        cookie: `pf_refresh=${refreshCookieValue(VICTIM, "r")}`,
      })
    );
    expect(res.status).toBe(200);
    expect(provider.signOut).toHaveBeenCalledWith(tokenA, "r");
    expect(provider.refreshToken).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith(A);
    expect(revoke).not.toHaveBeenCalledWith(VICTIM);
    expect(logoutRecord()).toMatchObject({ actorId: A, targetId: A });
  });

  it("a bearer the provider does not verify proves nobody; the cookie's user is proven by its refresh", async () => {
    provider.verifyToken.mockResolvedValue(null);
    provider.refreshToken.mockResolvedValue({
      userId: VICTIM,
      accessToken: "minted",
      refreshToken: "r",
      expiresAt: 0,
    });
    await signOut(
      req("/api/auth/sign-out", {
        headers: { authorization: `Bearer ${tokenOf(A)}` },
        cookie: `pf_refresh=${refreshCookieValue(VICTIM, "r")}`,
      })
    );
    // The holder of B's real refresh token signs B out — proven by the provider, not the cookie.
    expect(provider.signOut).toHaveBeenCalledWith("minted", "r");
    expect(revoke).toHaveBeenCalledWith(VICTIM);
    expect(revoke).not.toHaveBeenCalledWith(A);
  });

  it("a provider that cannot verify the bearer (unavailable) proves nobody from it", async () => {
    provider.verifyToken.mockRejectedValue(
      new tv.TokenVerificationUnavailableError("down")
    );
    await signOut(
      req("/api/auth/sign-out", { headers: { authorization: `Bearer ${tokenOf(A)}` } })
    );
    expect(provider.signOut).toHaveBeenCalledWith(tokenOf(A), undefined);
    expect(revoke).not.toHaveBeenCalled();
    expect(logoutRecord()?.actorId).toBeUndefined();
  });

  it("legitimate: bearer and cookie of one user — revoked, voided and recorded as that user", async () => {
    const token = tokenOf(A);
    const forget = jest.spyOn(tv, "forgetTokenVerification");
    const res = await signOut(
      req("/api/auth/sign-out", {
        headers: { authorization: `Bearer ${token}` },
        cookie: `pf_refresh=${refreshCookieValue(A, "refresh.a")}`,
      })
    );
    expect(res.status).toBe(200);
    expect(provider.signOut).toHaveBeenCalledWith(token, "refresh.a");
    expect(forget).toHaveBeenCalledWith(token);
    expect(revoke).toHaveBeenCalledWith(A);
    expect(logoutRecord()).toMatchObject({ actorId: A, targetId: A });
    forget.mockRestore();
  });

  it("a revocation that failed records nothing and voids nothing", async () => {
    provider.signOut.mockRejectedValue(new Error("down"));
    const res = await signOut(
      req("/api/auth/sign-out", { headers: { authorization: `Bearer ${tokenOf(A)}` } })
    );
    expect(res.status).toBe(500);
    expect(revoke).not.toHaveBeenCalled();
    expect(logoutRecord()).toBeUndefined();
  });
});

describe("review 17 M1: no key, no refresh cookie", () => {
  it("a production server without REFRESH_COOKIE_KEY hands out the session without a cookie it could not sign", async () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = { node: env.NODE_ENV, key: env.REFRESH_COOKIE_KEY };
    provider.signIn.mockResolvedValue({
      success: true,
      userId: A,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresIn: 3600,
    });
    try {
      delete env.REFRESH_COOKIE_KEY;
      env.NODE_ENV = "production";
      const res = await signIn(
        req("/api/auth/sign-in", { body: { email: "a@b.c", password: "p" } })
      );
      expect(res.status).toBe(200);
      expect(res.cookies.get("pf_refresh")).toBeUndefined();
      expect(res.cookies.get("pf_has_session")?.value).toBe("true");
    } finally {
      env.NODE_ENV = saved.node;
      if (saved.key === undefined) delete env.REFRESH_COOKIE_KEY;
      else env.REFRESH_COOKIE_KEY = saved.key;
    }
  });
});

describe("review 17 L2/L4: the readiness probe over the registered provider", () => {
  afterEach(() => {
    delete provider.checkPoolShape;
  });

  it("a provider without checkPoolShape is not checked (healthy)", async () => {
    expect((await createAuthPoolShapeProbe().check()).status).toBe("healthy");
  });

  it("asks the registered provider's checkPoolShape", async () => {
    provider.checkPoolShape = jest.fn(async () => ({
      state: "unsafe",
      cause: "username_sign_in",
      reason: "the pool signs in by username",
    }));
    expect(await createAuthPoolShapeProbe().check()).toMatchObject({
      name: "identity-pool",
      status: "unhealthy",
      detail: "the pool signs in by username",
    });
  });
});
