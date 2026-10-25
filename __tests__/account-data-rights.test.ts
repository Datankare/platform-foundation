/**
 * __tests__/account-data-rights.test.ts — A user's own export and erasure (GDPR Articles 15 and
 * 17; audit X-15, RR-23)
 *
 * GET /api/account/export and POST /api/account/delete did not exist: erasure was an admin purge
 * only, and no route exported anything. Hostile cases: anonymous and guest callers, a role
 * without the permission, a missing or wrong confirmation, a malformed body, a partial export
 * (refused whole), an audit outage, an account already erased, an identity provider that fails.
 */

import { NextRequest } from "next/server";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));
jest.mock("@/platform/auth/permissions-cache", () =>
  require("@/__tests__/helpers/test-identities").mockPermissionsCache()
);
jest.mock("@/platform/rate-limit", () =>
  require("@/__tests__/helpers/test-identities").mockRateLimit()
);
// requireActor: the test callers (a guest token is refused by the real route option).
jest.mock("@/platform/auth/middleware", () => {
  const actual = jest.requireActual("@/platform/auth/middleware");
  const { apiError } = jest.requireActual("@/platform/errors");
  const ids = jest.requireActual("@/__tests__/helpers/test-identities");
  return {
    ...actual,
    requireActor: jest.fn(async (request: NextRequest) => {
      const header = request.headers.get("authorization") ?? "";
      if (header.startsWith("Bearer guest.")) {
        return { error: apiError("auth.sign_in_required", { request }) };
      }
      const name = /^Bearer test-token:test-sub-/.test(header)
        ? Object.values(ids.CALLERS as Record<string, { sub: string }>).find(
            (c) => header === `Bearer test-token:${c.sub}`
          )
        : undefined;
      if (!name) return { error: apiError("auth.required", { request }) };
      const identity = name as { sub: string; userId: string };
      return {
        actor: {
          kind: "user",
          id: identity.userId,
          tenantId: "t",
          user: { sub: identity.sub, email: "x@test" },
        },
      };
    }),
  };
});
const mockExport = jest.fn();
jest.mock("@/platform/auth/data-export", () => ({
  EXPORT_TOO_LARGE: "export.too_large",
  exportUserData: (...a: unknown[]) => mockExport(...a),
}));
const mockSoftDelete = jest.fn();
jest.mock("@/platform/auth/gdpr-deletion", () => ({
  softDeleteUser: (...a: unknown[]) => mockSoftDelete(...a),
}));
const mockDeleteIdentity = jest.fn();
jest.mock("@/platform/auth/config", () => ({
  getAuthProvider: () => ({ deleteUser: mockDeleteIdentity }),
  hasAuthProvider: () => true,
  registerAuthProvider: jest.fn(),
}));
jest.mock("@/platform/auth/auth-init", () => ({ initAuth: jest.fn() }));

import { GET as exportGET } from "@/app/api/account/export/route";
import { POST as deletePOST } from "@/app/api/account/delete/route";
import { CALLERS, authAs, type CallerName } from "@/__tests__/helpers/test-identities";

const request = (
  path: string,
  caller: CallerName | "guest-token",
  init: { method?: string; body?: unknown; raw?: string } = {}
) =>
  new NextRequest(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(caller === "guest-token"
        ? { authorization: "Bearer guest.abc" }
        : authAs(caller as CallerName)),
    },
    ...(init.raw !== undefined
      ? { body: init.raw }
      : init.body !== undefined
        ? { body: JSON.stringify(init.body) }
        : {}),
  });

const exportAs = (caller: CallerName | "guest-token") =>
  exportGET(request("/api/account/export", caller));
const deleteAs = (
  caller: CallerName | "guest-token",
  body: unknown = { confirm: "DELETE" }
) => deletePOST(request("/api/account/delete", caller, { method: "POST", body }));

beforeEach(() => {
  jest.clearAllMocks();
  mockExport.mockResolvedValue({
    data: { profile: { id: CALLERS.free.userId } },
    errors: [],
  });
  mockSoftDelete.mockResolvedValue({ success: true, errors: [] });
  mockDeleteIdentity.mockResolvedValue({ success: true });
});

describe("GET /api/account/export", () => {
  it("returns the caller's own data, uncached, as a download", async () => {
    const res = await exportAs("free");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profile: { id: CALLERS.free.userId } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/attachment/);
    expect(mockExport).toHaveBeenCalledWith(CALLERS.free.userId);
  });

  it.each(["anonymous", "guest-token"] as const)("refuses %s", async (caller) => {
    const res = await exportAs(caller);
    expect(res.status).toBe(401);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("refuses a role without can_export_data", async () => {
    const res = await exportAs("moderator");
    expect(res.status).toBe(403);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("gives nothing when any part could not be read (RR-23)", async () => {
    mockExport.mockResolvedValue({ data: {}, errors: ["strikes store: down"] });
    const res = await exportAs("free");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("service.unavailable");
    expect(JSON.stringify(body)).not.toContain("profile");
  });

  it("answers 503 audit when the export cannot be recorded", async () => {
    mockExport.mockResolvedValue({ data: {}, errors: ["audit unavailable"] });
    const res = await exportAs("free");
    expect(res.status).toBe(503);
    expect((await res.json()).params).toMatchObject({ service: "audit" });
  });

  it("answers account.not_found for an erased account", async () => {
    mockExport.mockResolvedValue({ data: {}, errors: ["users: no live user row"] });
    const res = await exportAs("free");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("account.not_found");
  });

  it("answers 413 account.export_too_large over the cap — no cut-off copy (review 7 M2)", async () => {
    mockExport.mockResolvedValue({ data: {}, errors: ["export.too_large"] });
    const res = await exportAs("free");
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe("account.export_too_large");
    expect(body.params).toMatchObject({ limit: 100_000 });
  });
});

describe("POST /api/account/delete", () => {
  it("erases the caller's own account, deletes the identity, clears the session", async () => {
    const res = await deleteAs("free");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, identityDeleted: true });
    expect(mockSoftDelete).toHaveBeenCalledWith(CALLERS.free.userId, CALLERS.free.userId);
    expect(mockDeleteIdentity).toHaveBeenCalledWith(`test-token:${CALLERS.free.sub}`);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/pf_refresh=;/);
  });

  it.each([
    ["no body", undefined],
    ["no confirmation", {}],
    ["the wrong confirmation", { confirm: "delete" }],
    ["a non-text confirmation", { confirm: true }],
    ["an array", ["DELETE"]],
  ])("refuses %s and erases nothing", async (_label, body) => {
    const res = await deletePOST(
      request("/api/account/delete", "free", {
        method: "POST",
        ...(body === undefined ? { raw: "" } : { body }),
      })
    );
    expect(res.status).toBe(400);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it.each(["anonymous", "guest-token"] as const)("refuses %s", async (caller) => {
    expect((await deleteAs(caller)).status).toBe(401);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("refuses a role without can_delete_account", async () => {
    expect((await deleteAs("safety_approver")).status).toBe(403);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("an erasure that did not complete answers 503 and deletes no identity", async () => {
    mockSoftDelete.mockResolvedValue({ success: false, errors: ["audit unavailable"] });
    const res = await deleteAs("free");
    expect(res.status).toBe(503);
    expect((await res.json()).params).toMatchObject({ service: "audit" });
    expect(mockDeleteIdentity).not.toHaveBeenCalled();
  });

  it("an account already gone answers account.not_found", async () => {
    mockSoftDelete.mockResolvedValue({ success: false, errors: ["users: no such user"] });
    const res = await deleteAs("free");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("account.not_found");
  });

  it("says so when the identity could not be deleted (the account is closed either way)", async () => {
    mockDeleteIdentity.mockRejectedValue(new Error("provider down"));
    const res = await deleteAs("free");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, identityDeleted: false });
  });
});
