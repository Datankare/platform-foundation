/**
 * Auth middleware — additional integrity tests.
 *
 * Covers branches missing from auth-middleware.test.ts:
 * - requirePermission (entire function — auth guard for admin ops)
 * - requireAuth catch branch (token verification throws)
 */

import { NextRequest } from "next/server";

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  generateRequestId: () => "test-req-id",
}));

jest.mock("@/platform/auth/config", () => ({
  getAuthProvider: jest.fn(),
}));

jest.mock("@/platform/auth/permissions-cache", () => ({
  hasCachedPermission: jest.fn(),
}));

import { requireAuth, requirePermission } from "@/platform/auth/middleware";
import { getAuthProvider } from "@/platform/auth/config";
import { hasCachedPermission } from "@/platform/auth/permissions-cache";

const mockGetAuthProvider = getAuthProvider as jest.Mock;
const mockHasCachedPermission = hasCachedPermission as jest.Mock;

function makeRequest(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/test", { headers });
}

describe("requireAuth — error handling", () => {
  it("returns 401 when verifyToken throws an exception", async () => {
    mockGetAuthProvider.mockReturnValue({
      verifyToken: jest.fn().mockRejectedValue(new Error("JWT decode failed")),
    });

    const result = await requireAuth(makeRequest("bad-token"));
    expect(result.error).toBeDefined();
    expect(result.error!.status).toBe(401);

    const body = await result.error!.json();
    expect(body.error).toBe("Authentication failed");
  });

  it("returns 401 when verifyToken returns null", async () => {
    mockGetAuthProvider.mockReturnValue({
      verifyToken: jest.fn().mockResolvedValue(null),
    });

    const result = await requireAuth(makeRequest("expired-token"));
    expect(result.error).toBeDefined();
    expect(result.error!.status).toBe(401);

    const body = await result.error!.json();
    expect(body.error).toBe("Invalid or expired token");
  });
});

describe("requirePermission", () => {
  it("returns granted: true when user has the permission", async () => {
    mockHasCachedPermission.mockResolvedValue(true);

    const result = await requirePermission("user-123", "admin_manage_users");
    expect(result.granted).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns 403 when user lacks the permission", async () => {
    mockHasCachedPermission.mockResolvedValue(false);

    const result = await requirePermission("user-123", "admin_manage_users");
    expect(result.error).toBeDefined();
    expect(result.error!.status).toBe(403);

    const body = await result.error!.json();
    expect(body.error).toBe("Permission denied");
    expect(body.required).toBe("admin_manage_users");
  });

  it("checks the correct user and permission code", async () => {
    mockHasCachedPermission.mockResolvedValue(true);

    await requirePermission("cognito-sub-abc", "can_translate");
    expect(mockHasCachedPermission).toHaveBeenCalledWith(
      "cognito-sub-abc",
      "can_translate"
    );
  });
});
