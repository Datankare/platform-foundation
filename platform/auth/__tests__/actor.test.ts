/**
 * ADR-050 D4 / TASK-099 — actors: opt-in guest routes, namespaced guest ids.
 */
import { NextRequest } from "next/server";
import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import { requireActor, requireAuth } from "@/platform/auth/middleware";
import { requireActorWithStatus } from "@/platform/auth/actor-guard";
import { mintGuestToken, newGuestId } from "@/platform/auth/guest-token";
import { checkAccountStatus } from "@/platform/auth/account-status-guard";
import type { AuthProvider } from "@/platform/auth/provider";

jest.mock("@/lib/logger", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "test-req-id",
}));

jest.mock("@/platform/auth/account-status-guard", () => ({
  checkAccountStatus: jest.fn(),
}));
const mockStatus = checkAccountStatus as jest.MockedFunction<typeof checkAccountStatus>;

function req(token?: string): NextRequest {
  const headers = new Headers();
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
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
  mockStatus.mockReset();
  mockStatus.mockResolvedValue({
    allowed: true,
    accountStatus: "active",
    feature: "translate",
  } as Awaited<ReturnType<typeof checkAccountStatus>>);
});

describe("requireActor", () => {
  it("fixture: the mock provider yields a user token", () => {
    expect(userToken).not.toBe("");
    expect(userId).not.toBe("");
  });

  it("a signed-in user is a user actor on any route", async () => {
    for (const allowGuests of [true, false]) {
      const r = await requireActor(req(userToken), { allowGuests });
      expect(r.actor).toEqual(expect.objectContaining({ kind: "user", id: userId }));
    }
  });

  it("a signed guest is a guest actor where the route opts in", async () => {
    const { token, guestId, expiresAt } = await mintGuestToken();
    const r = await requireActor(req(token), { allowGuests: true });
    expect(r.actor).toEqual({ kind: "guest", id: guestId, expiresAt });
  });

  it("a guest on a route that does not opt in gets 401 sign_in_required", async () => {
    const { token } = await mintGuestToken();
    const r = await requireActor(req(token), { allowGuests: false });
    expect(r.error?.status).toBe(401);
    await expect(r.error?.json()).resolves.toEqual(
      expect.objectContaining({ code: "auth.sign_in_required" })
    );
  });

  it("a forged or expired guest token gets 401 guest_invalid", async () => {
    const r = await requireActor(req("guest.e30.AAAA"), { allowGuests: true });
    expect(r.error?.status).toBe(401);
    await expect(r.error?.json()).resolves.toEqual(
      expect.objectContaining({ code: "auth.guest_invalid" })
    );
  });

  it("the provider's own guest format is never accepted as a guest", async () => {
    const r = await requireActor(req("mock-guest-token"), { allowGuests: true });
    expect(r.error?.status).toBe(401);
  });

  it("no token is 401", async () => {
    expect((await requireActor(req(), { allowGuests: true })).error?.status).toBe(401);
    expect((await requireActor(req("   "), { allowGuests: true })).error?.status).toBe(
      401
    );
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
      const r = await requireAuth(req("any-token"));
      expect(r.error?.status).toBe(401);
    } finally {
      registerAuthProvider(createMockAuthProvider());
    }
  });
});

describe("requireActorWithStatus", () => {
  it("checks account status for users", async () => {
    const r = await requireActorWithStatus(req(userToken), "translate", {
      allowGuests: true,
    });
    expect(r.actor?.kind).toBe("user");
    expect(mockStatus).toHaveBeenCalledWith(userId, "translate");
  });

  it("returns 403 when account status denies", async () => {
    mockStatus.mockResolvedValueOnce({
      allowed: false,
      reason: "Account suspended",
      accountStatus: "suspended",
      feature: "translate",
    } as Awaited<ReturnType<typeof checkAccountStatus>>);
    const r = await requireActorWithStatus(req(userToken), "translate", {
      allowGuests: true,
    });
    expect(r.error?.status).toBe(403);
  });

  it("guests skip account status (no account) on opted-in routes", async () => {
    const { token } = await mintGuestToken();
    const r = await requireActorWithStatus(req(token), "translate", {
      allowGuests: true,
    });
    expect(r.actor?.kind).toBe("guest");
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("passes auth errors through", async () => {
    const { token } = await mintGuestToken();
    const r = await requireActorWithStatus(req(token), "profile", { allowGuests: false });
    expect(r.error?.status).toBe(401);
    expect(mockStatus).not.toHaveBeenCalled();
  });
});
