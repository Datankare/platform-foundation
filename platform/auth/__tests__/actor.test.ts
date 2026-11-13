/**
 * ADR-050 D4 / TASK-099 — actors: opt-in guest routes, namespaced guest ids.
 */
import { DEFAULT_TENANT_ID } from "@/platform/providers/environment-contract";
import { NextRequest } from "next/server";
import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import { requireActor, requireAuth } from "@/platform/auth/middleware";
import { requireActorWithStatus } from "@/platform/auth/actor-guard";
import { RESTRICTED_MARKER } from "@/platform/auth/restricted-marker";
import { mintGuestToken, newGuestId } from "@/platform/auth/guest-token";
import { checkAccountStatus } from "@/platform/auth/account-status-guard";
import { checkCoppaGate } from "@/platform/auth/coppa-gate";
import type { AuthProvider } from "@/platform/auth/provider";
import { sessionHeadersFor } from "@/__tests__/helpers/session";

jest.mock("@/lib/logger", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "test-req-id",
}));

jest.mock("@/platform/auth/account-status-guard", () => ({
  checkAccountStatus: jest.fn(),
}));
const mockStatus = checkAccountStatus as jest.MockedFunction<typeof checkAccountStatus>;
jest.mock("@/platform/auth/coppa-gate", () => ({ checkCoppaGate: jest.fn() }));
const mockCoppa = checkCoppaGate as jest.MockedFunction<typeof checkCoppaGate>;
// The feature permission (TASK-194, C-4): the caller's role grants it unless a test says not.
const mockHeld = jest.fn(async (_sub: string, _permission: string) => true);
// By the account (round 1, C3): the subject and the account id the identity is bound to.
const mockAccountHeld = jest.fn(
  async (_sub: string, _account: string, _p: string) => true
);
// The role could not be read (round 2, N3).
const mockUnreadable = { value: false };
// A guest's, from the guest role (round 1, C2).
const mockGuestHeld = jest.fn(async (_permission: string) => true);
jest.mock("@/platform/auth/permissions-cache", () => ({
  ...jest.requireActual("@/platform/auth/permissions-cache"),
  hasCachedPermission: (sub: string, permission: string) => mockHeld(sub, permission),
  accountPermissionStanding: async (sub: string, account: string, permission: string) => {
    if (mockUnreadable.value) return "unknown";
    return (await mockAccountHeld(sub, account, permission)) &&
      (await mockHeld(sub, permission))
      ? "held"
      : "lacking";
  },
  hasGuestPermission: (permission: string) => mockGuestHeld(permission),
}));

/** A request from a browser whose session holds `token` (ADR-057); none: no session. */
async function req(token?: string): Promise<NextRequest> {
  const headers = new Headers(token === undefined ? {} : await sessionHeadersFor(token));
  return new NextRequest("http://localhost:3000/api/translate/dispatch", { headers });
}

let userToken = "";
let userId = "";

beforeAll(async () => {
  const mock = createMockAuthProvider();
  registerAuthProvider(mock);
  const signIn = await mock.signIn("a@b.c", "x");
  userToken = signIn.accessToken ?? "";
  userId = (await mock.verifyToken(userToken))?.sub ?? "";
});

beforeEach(() => {
  mockHeld.mockClear();
  mockHeld.mockResolvedValue(true);
  mockAccountHeld.mockClear();
  mockAccountHeld.mockResolvedValue(true);
  mockGuestHeld.mockClear();
  mockGuestHeld.mockResolvedValue(true);
  mockUnreadable.value = false;
  mockStatus.mockReset();
  mockStatus.mockResolvedValue({
    allowed: true,
    accountStatus: "active",
    feature: "translate",
  } as Awaited<ReturnType<typeof checkAccountStatus>>);
  mockCoppa.mockReset();
  mockCoppa.mockResolvedValue({
    allowed: true,
    reason: "",
    feature: "translate",
    contentRatingLevel: 3,
    consentStatus: "not_required",
  });
});

describe("requireActor", () => {
  it("fixture: the mock provider yields a user token", () => {
    expect(userToken).not.toBe("");
    expect(userId).not.toBe("");
  });

  it("a signed-in user is a user actor on any route", async () => {
    for (const allowGuests of [true, false]) {
      const r = await requireActor(await req(userToken), { allowGuests });
      expect(r.actor).toEqual(expect.objectContaining({ kind: "user", id: userId }));
    }
  });

  it("a signed guest is a guest actor where the route opts in", async () => {
    const { token, guestId, expiresAt } = await mintGuestToken();
    const r = await requireActor(await req(token), { allowGuests: true });
    expect(r.actor).toEqual({
      kind: "guest",
      id: guestId,
      tenantId: DEFAULT_TENANT_ID,
      expiresAt,
    });
  });

  it("a guest on a route that does not opt in gets 401 sign_in_required", async () => {
    const { token } = await mintGuestToken();
    const r = await requireActor(await req(token), { allowGuests: false });
    expect(r.error?.status).toBe(401);
    await expect(r.error?.json()).resolves.toEqual(
      expect.objectContaining({ code: "auth.sign_in_required" })
    );
  });

  it("a forged or expired guest token gets 401 guest_invalid", async () => {
    const r = await requireActor(await req("guest.e30.AAAA"), { allowGuests: true });
    expect(r.error?.status).toBe(401);
    await expect(r.error?.json()).resolves.toEqual(
      expect.objectContaining({ code: "auth.guest_invalid" })
    );
  });

  it("the provider's own guest format is never accepted as a guest", async () => {
    const r = await requireActor(await req("mock-guest-token"), { allowGuests: true });
    expect(r.error?.status).toBe(401);
  });

  it("no token is 401", async () => {
    expect((await requireActor(await req(), { allowGuests: true })).error?.status).toBe(
      401
    );
    expect(
      (await requireActor(await req("   "), { allowGuests: true })).error?.status
    ).toBe(401);
  });
});

describe("guest namespace (D4)", () => {
  it("requireAuth rejects a user token whose subject is guest-namespaced", async () => {
    const rogue = {
      ...createMockAuthProvider(),
      verifyToken: jest.fn().mockResolvedValue({ sub: newGuestId(), email: "x@y.z" }),
    } as unknown as AuthProvider;
    registerAuthProvider(rogue);
    try {
      const r = await requireAuth(await req("any-token"));
      expect(r.error?.status).toBe(401);
    } finally {
      registerAuthProvider(createMockAuthProvider());
    }
  });
});

describe("requireActorWithStatus", () => {
  // TASK-194, audit C-4: a feature that maps to a permission needs it, from the caller's role.
  it.each([
    ["translate", "can_translate"],
    ["view_profile", "can_view_profile"],
    ["update_profile", "can_edit_profile"],
  ])(
    "refuses %s to a user whose role lacks %s (403 auth.permission_denied)",
    async (feature, permission) => {
      mockHeld.mockResolvedValue(false);
      const r = await requireActorWithStatus(await req(userToken), feature, {
        allowGuests: false,
      });
      expect(r.error?.status).toBe(403);
      expect(await r.error?.json()).toMatchObject({
        code: "auth.permission_denied",
        params: { permission },
      });
      expect(mockHeld).toHaveBeenCalledWith(expect.any(String), permission);
    }
  );

  it("asks no permission of a feature that maps to none", async () => {
    mockHeld.mockResolvedValue(false);
    mockGuestHeld.mockResolvedValue(false);
    const r = await requireActorWithStatus(await req(userToken), "stream", {
      allowGuests: false,
    });
    expect(r.actor?.kind).toBe("user");
    expect(mockHeld).not.toHaveBeenCalled();
    const { token } = await mintGuestToken();
    const g = await requireActorWithStatus(await req(token), "stream", {
      allowGuests: true,
    });
    expect(g.actor?.kind).toBe("guest");
    expect(mockGuestHeld).not.toHaveBeenCalled();
  });

  // Round 1, C3: resolved by the account the identity is bound to, not only the subject.
  it("resolves a user's permission by their account id", async () => {
    await requireActorWithStatus(await req(userToken), "translate", {
      allowGuests: false,
    });
    expect(mockAccountHeld).toHaveBeenCalledWith(userId, userId, "can_translate");
  });

  // Round 1, C2: a guest acts under the guest role; taking can_translate from it takes effect.
  it("refuses a guest the feature when the guest role lacks its permission", async () => {
    mockGuestHeld.mockResolvedValue(false);
    const { token } = await mintGuestToken();
    const r = await requireActorWithStatus(await req(token), "translate", {
      allowGuests: true,
    });
    expect(r.error?.status).toBe(403);
    expect(await r.error?.json()).toMatchObject({
      code: "auth.permission_denied",
      params: { permission: "can_translate" },
    });
    expect(mockGuestHeld).toHaveBeenCalledWith("can_translate");
  });

  // Round 1, C2: refused as themselves, a user is marked so the browser cannot go on as a guest.
  it("marks a user refused a feature's permission, so no guest token follows", async () => {
    mockHeld.mockResolvedValue(false);
    const r = await requireActorWithStatus(await req(userToken), "translate", {
      allowGuests: true,
    });

    expect(r.error?.status).toBe(403);
    expect(r.error?.cookies.get(RESTRICTED_MARKER)?.value).toBe("1");
  });

  // Round 2, N3: only a definite refusal, and only where a guest would get the feature.
  it("marks nothing when the role cannot be read: 503, not a refusal", async () => {
    mockUnreadable.value = true;
    const r = await requireActorWithStatus(await req(userToken), "translate", {
      allowGuests: true,
    });
    expect(r.error?.status).toBe(503);
    expect((await r.error?.json()).code).toBe("service.unavailable");
    expect(r.error?.cookies.get(RESTRICTED_MARKER)).toBeUndefined();
  });

  it("marks nothing for a refusal on a route guests cannot use (can_edit_profile)", async () => {
    mockHeld.mockResolvedValue(false);
    const r = await requireActorWithStatus(await req(userToken), "update_profile", {
      allowGuests: false,
    });
    expect(r.error?.status).toBe(403);
    expect(r.error?.cookies.get(RESTRICTED_MARKER)).toBeUndefined();
  });

  it("checks account status for users", async () => {
    const r = await requireActorWithStatus(await req(userToken), "translate", {
      allowGuests: true,
    });
    expect(r.actor?.kind).toBe("user");
    expect(mockStatus).toHaveBeenCalledWith(userId, "translate", {
      email: expect.any(String),
      emailVerified: expect.any(Boolean),
    });
  });

  it("returns 503 account.not_provisioned — not a restriction — when provisioning failed", async () => {
    mockStatus.mockResolvedValueOnce({
      allowed: false,
      reason: "set up",
      accountStatus: "banned",
      feature: "translate",
      code: "account.not_provisioned",
    } as Awaited<ReturnType<typeof checkAccountStatus>>);
    const r = await requireActorWithStatus(await req(userToken), "translate", {
      allowGuests: true,
    });
    expect(r.error?.status).toBe(503);
    expect((await r.error?.json()).code).toBe("account.not_provisioned");
  });

  it("returns 403 when account status denies", async () => {
    mockStatus.mockResolvedValueOnce({
      allowed: false,
      reason: "Account suspended",
      accountStatus: "suspended",
      feature: "translate",
    } as Awaited<ReturnType<typeof checkAccountStatus>>);
    const r = await requireActorWithStatus(await req(userToken), "translate", {
      allowGuests: true,
    });
    expect(r.error?.status).toBe(403);
  });

  it("guests skip account status (no account) on opted-in routes", async () => {
    const { token } = await mintGuestToken();
    const r = await requireActorWithStatus(await req(token), "translate", {
      allowGuests: true,
    });
    expect(r.actor?.kind).toBe("guest");
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("passes auth errors through", async () => {
    const { token } = await mintGuestToken();
    const r = await requireActorWithStatus(await req(token), "profile", {
      allowGuests: false,
    });
    expect(r.error?.status).toBe(401);
    expect(mockStatus).not.toHaveBeenCalled();
  });
});

describe("requireActorWithStatus — age and consent (audit X-16)", () => {
  it.each([
    ["account.age_unverified", 403],
    ["account.consent_required", 403],
  ] as const)("refuses a user the gate refuses with %s", async (code, status) => {
    mockCoppa.mockResolvedValueOnce({
      allowed: false,
      reason: "x",
      feature: "stream",
      contentRatingLevel: 1,
      consentStatus: "pending",
      code,
    });
    const r = await requireActorWithStatus(await req(userToken), "stream", {
      allowGuests: false,
    });
    expect(r.error?.status).toBe(status);
    await expect(r.error?.json()).resolves.toMatchObject({
      code,
      params: { feature: "stream" },
    });
    expect(mockCoppa).toHaveBeenCalledWith(userId, "stream");
  });

  it("checks the gate only after account standing allows", async () => {
    mockStatus.mockResolvedValueOnce({
      allowed: false,
      accountStatus: "banned",
      feature: "stream",
      reason: "x",
    } as Awaited<ReturnType<typeof checkAccountStatus>>);
    await requireActorWithStatus(await req(userToken), "stream", { allowGuests: false });
    expect(mockCoppa).not.toHaveBeenCalled();
  });

  it("does not gate a guest (no account, no age)", async () => {
    const { token } = await mintGuestToken();
    const r = await requireActorWithStatus(await req(token), "translate", {
      allowGuests: true,
    });
    expect(r.actor?.kind).toBe("guest");
    expect(mockCoppa).not.toHaveBeenCalled();
  });

  it("answers an erased account account.not_found (audit A-11)", async () => {
    mockStatus.mockResolvedValueOnce({
      allowed: false,
      accountStatus: "banned",
      feature: "translate",
      reason: "deleted",
      code: "account.not_found",
    } as Awaited<ReturnType<typeof checkAccountStatus>>);
    const r = await requireActorWithStatus(await req(userToken), "translate", {
      allowGuests: false,
    });
    expect(r.error?.status).toBe(403);
    await expect(r.error?.json()).resolves.toMatchObject({ code: "account.not_found" });
  });
});
