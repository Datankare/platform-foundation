/**
 * __tests__/r17-hostile-signout.test.ts — review 17 M1, kept as regression tests under ADR-057:
 * sign-out ends, revokes and records only the session its cookie names — the session's own
 * record is the proof of whose it was — never an id a request merely states.
 *
 * Hostile cases: a legacy refresh cookie forged for a victim (unsigned, a made-up MAC, a real MAC
 * with the id swapped) revokes and records nothing; a legacy cookie naming B beside A's session
 * records A alone; a bearer header naming a victim is not read at all; a replayed sign-out records
 * nothing twice. Legitimate: the session's user is ended, revoked at the provider and recorded;
 * a provider that fails to revoke does not keep the session alive.
 */

import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

const provider: Record<string, jest.Mock | undefined> & {
  signOut: jest.Mock;
  verifyToken: jest.Mock;
} = {
  signOut: jest.fn(),
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
jest.mock("@/platform/auth/account-identity", () => ({
  ...jest.requireActual("@/platform/auth/account-identity"),
  auditableAccountId: async (subject: string) => subject,
}));

import { resetRateLimiter } from "@/platform/rate-limit";
import { POST as signOut } from "@/app/api/auth/sign-out/route";
import { createAuthPoolShapeProbe } from "@/platform/auth/pool-shape-probe";
import { MemorySessionStore, setSessionStore } from "@/platform/auth/session-store";
import { DEFAULT_TENANT_ID, runWithTenant } from "@/platform/tenancy/context";
import { startTestSession } from "./helpers/session";

const VICTIM = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f01234567";
const ATTACKER = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const A = "aaaaaaaa-1111-4111-8111-111111111111";

const COOKIE_KEY = "legacy-cookie-key-".padEnd(48, "k");
/** A legacy refresh cookie's value as the code before ADR-057 signed it. */
const legacyValue = (userId: string, token: string): string =>
  `${userId}.${createHmac("sha256", COOKIE_KEY)
    .update(`pf_refresh.v1\0${userId}\0${token}`)
    .digest("base64url")}.${token}`;

function req(
  options: { headers?: Record<string, string>; cookie?: string } = {}
): NextRequest {
  return new NextRequest("http://localhost/api/auth/sign-out", {
    method: "POST",
    headers: {
      "x-forwarded-for": "203.0.113.7",
      "user-agent": "jest",
      ...(options.headers ?? {}),
      ...(options.cookie
        ? {
            cookie: [options.headers?.cookie, options.cookie].filter(Boolean).join("; "),
          }
        : {}),
    },
  });
}

const logoutRecords = () =>
  mockRecordAudit.mock.calls
    .map((c) => c[0] as { action: string; actorId?: string; targetId?: string })
    .filter((r) => r.action === "logout");

let store: MemorySessionStore;
const savedKey = process.env.REFRESH_COOKIE_KEY;

beforeEach(() => {
  jest.clearAllMocks();
  resetRateLimiter();
  process.env.REFRESH_COOKIE_KEY = COOKIE_KEY;
  mockHasDatabase.mockReturnValue(true);
  mockRecordAudit.mockResolvedValue(undefined);
  provider.signOut.mockResolvedValue(undefined);
  provider.verifyToken.mockResolvedValue(null);
  store = new MemorySessionStore();
  setSessionStore(store);
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.REFRESH_COOKIE_KEY;
  else process.env.REFRESH_COOKIE_KEY = savedKey;
});

const recordOf = (idHash: string) =>
  runWithTenant({ tenantId: DEFAULT_TENANT_ID, mode: "single" }, () =>
    store.find(idHash)
  );

// hostile:role n/a: sign-out needs no role: any session may end itself, and only itself
// hostile:id-spelling n/a: the legacy cookie's user id is inside its MAC, byte for byte: another spelling is another cookie, refused as forged (the first case)

describe("review 17 M1: a forged legacy refresh cookie is no cookie", () => {
  it.each([
    ["unsigned (the reviewer's proof)", `${VICTIM}.attackers-own-refresh`],
    [
      "the attacker's own signed cookie with the victim's id swapped in",
      legacyValue(ATTACKER, "attackers-own-refresh").replace(ATTACKER, VICTIM),
    ],
    ["a made-up MAC", `${VICTIM}.${"A".repeat(43)}.attackers-own-refresh`],
  ])(
    "%s: nothing revoked, the victim's session untouched, no logout recorded",
    async (_label, cookie) => {
      const victim = await startTestSession({ subject: VICTIM, refreshToken: "victims" });
      const res = await signOut(req({ cookie: `pf_refresh=${cookie}` }));
      expect(res.status).toBe(200);
      expect(provider.signOut).not.toHaveBeenCalled();
      expect(logoutRecords()).toEqual([]);
      expect(JSON.stringify(mockRecordAudit.mock.calls)).not.toContain(VICTIM);
      expect((await recordOf(victim.idHash))?.revokedAt).toBeUndefined();
      expect(res.headers.get("set-cookie")).toMatch(/pf_refresh=;.*Max-Age=0/i);
    }
  );

  it("a genuine legacy cookie has its own token revoked, and names nobody in the record", async () => {
    const res = await signOut(
      req({ cookie: `pf_refresh=${legacyValue(VICTIM, "refresh-v")}` })
    );
    expect(res.status).toBe(200);
    expect(provider.signOut).toHaveBeenCalledTimes(1);
    expect(provider.signOut).toHaveBeenCalledWith("", "refresh-v");
    // Holding a refresh token proves nothing the record is willing to state (no session ended).
    expect(logoutRecords()).toEqual([]);
  });
});

describe("review 17 M1: only the session's own subject is ended and recorded", () => {
  it("[hostile:self] the session is A's, a legacy cookie names B: A is ended and recorded, never B", async () => {
    const a = await startTestSession({ subject: A, refreshToken: "refresh-a" });
    const b = await startTestSession({ subject: VICTIM, refreshToken: "refresh-b" });
    const res = await signOut(
      req({ headers: a.headers, cookie: `pf_refresh=${legacyValue(VICTIM, "legacy-b")}` })
    );
    expect(res.status).toBe(200);
    expect((await recordOf(a.idHash))?.revokedReason).toBe("sign_out");
    expect((await recordOf(b.idHash))?.revokedAt).toBeUndefined();
    expect(provider.signOut.mock.calls).toEqual([
      ["", "refresh-a"],
      ["", "legacy-b"],
    ]);
    expect(logoutRecords()).toEqual([
      expect.objectContaining({ actorId: A, targetId: A }),
    ]);
  });

  it("a bearer header naming a victim is not a credential here: nobody is ended or recorded", async () => {
    const victim = await startTestSession({ subject: VICTIM, refreshToken: "victims" });
    const token = `x.${Buffer.from(JSON.stringify({ sub: VICTIM })).toString("base64url")}.y`;
    provider.verifyToken.mockResolvedValue({
      sub: VICTIM,
      email: "",
      emailVerified: false,
      iat: 0,
      exp: 9e9,
    });
    const res = await signOut(req({ headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(200);
    expect(provider.verifyToken).not.toHaveBeenCalled();
    expect(provider.signOut).not.toHaveBeenCalled();
    expect(logoutRecords()).toEqual([]);
    expect((await recordOf(victim.idHash))?.revokedAt).toBeUndefined();
  });

  it("the victim's session id without its forgery token (another site's POST) ends nothing", async () => {
    const victim = await startTestSession({ subject: VICTIM, refreshToken: "victims" });
    const res = await signOut(
      req({ headers: { cookie: victim.cookie, origin: "https://evil.example" } })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("auth.csrf_failed");
    expect((await recordOf(victim.idHash))?.revokedAt).toBeUndefined();
    expect(provider.signOut).not.toHaveBeenCalled();
    expect(logoutRecords()).toEqual([]);
  });

  it("a sign-out replayed with the ended id records and revokes nothing a second time", async () => {
    const a = await startTestSession({ subject: A, refreshToken: "refresh-a" });
    await signOut(req({ headers: a.headers }));
    const again = await signOut(req({ headers: a.headers }));
    expect(again.status).toBe(200);
    expect(provider.signOut).toHaveBeenCalledTimes(1);
    expect(logoutRecords()).toHaveLength(1);
  });

  it("[hostile:store-down] a provider that fails to revoke does not keep the session alive: the record ends it", async () => {
    provider.signOut.mockRejectedValue(new Error("down"));
    const a = await startTestSession({ subject: A, refreshToken: "refresh-a" });
    const res = await signOut(req({ headers: a.headers }));
    expect(res.status).toBe(200);
    expect((await recordOf(a.idHash))?.revokedReason).toBe("sign_out");
    expect(logoutRecords()).toEqual([expect.objectContaining({ actorId: A })]);
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
