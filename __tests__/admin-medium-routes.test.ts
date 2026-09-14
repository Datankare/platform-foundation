/**
 * __tests__/admin-medium-routes.test.ts — coverage remediation (ADR-040 "B", B2).
 *
 * guest-config, password-policy, entitlements (adminGuard + Supabase + audit) and gdpr
 * (requireAuth/requirePermission + PurgePipeline). Authorized, guard/auth denial,
 * data/default and error branches, and input validation.
 */
jest.mock("@/platform/auth/admin-guard", () => ({ adminGuard: jest.fn() }));
jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));
jest.mock("@/platform/auth/audit", () => ({ writeAuditLog: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("@/platform/auth/middleware", () => ({
  requireAuth: jest.fn(),
  requirePermission: jest.fn(),
}));
jest.mock("@/platform/gdpr", () => ({ PurgePipeline: jest.fn() }));

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { requireAuth, requirePermission } from "@/platform/auth/middleware";
import { PurgePipeline } from "@/platform/gdpr";

import { GET as guestGET, PUT as guestPUT } from "@/app/api/admin/guest-config/route";
import { GET as pwGET, PUT as pwPUT } from "@/app/api/admin/password-policy/route";
import { GET as entGET, PATCH as entPATCH } from "@/app/api/admin/entitlements/route";
import { POST as gdprPOST } from "@/app/api/admin/gdpr/route";

const mockGuard = adminGuard as jest.Mock;
const mockSupabase = getSupabaseServiceClient as jest.Mock;
const mockRequireAuth = requireAuth as jest.Mock;
const mockRequirePermission = requirePermission as jest.Mock;
const MockPurgePipeline = PurgePipeline as unknown as jest.Mock;

const denial = () => NextResponse.json({ error: "forbidden" }, { status: 403 });

function makeSupabase(tableResults: Record<string, { data?: unknown; error?: unknown }>) {
  const from = jest.fn((table: string) => {
    const result = tableResults[table] ?? { data: null, error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: Record<string, any> = {};
    const methods = [
      "select",
      "eq",
      "is",
      "order",
      "update",
      "insert",
      "upsert",
      "delete",
      "single",
      "in",
      "limit",
    ];
    for (const m of methods) {
      builder[m] = jest.fn(() => builder);
    }
    builder.then = (resolve: (v: unknown) => void) => resolve(result);
    return builder;
  });
  return { from };
}

function jsonReq(method: string, body?: unknown, raw?: string): NextRequest {
  const serialized =
    raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
  return new NextRequest("http://localhost/api/admin/x", {
    method,
    body: serialized,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGuard.mockResolvedValue(null);
});

describe("guest-config route", () => {
  it("GET returns the stored config", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({
        guest_config: {
          data: {
            nudge_after_sessions: 5,
            grace_after_sessions: 8,
            lockout_after_sessions: 11,
            guest_token_ttl_hours: 24,
          },
        },
      })
    );
    const res = await guestGET(jsonReq("GET"));
    const body = await res.json();
    expect(body.config.nudgeAfterSessions).toBe(5);
  });

  it("GET falls back to defaults when no row exists", async () => {
    mockSupabase.mockReturnValue(makeSupabase({ guest_config: { data: null } }));
    const res = await guestGET(jsonReq("GET"));
    const body = await res.json();
    expect(body.config.nudgeAfterSessions).toBe(3);
  });

  it("PUT writes a new config and returns success", async () => {
    mockSupabase.mockReturnValue(makeSupabase({ guest_config: { error: null } }));
    const res = await guestPUT(jsonReq("PUT", { nudgeAfterSessions: 2 }));
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("PUT returns 500 on insert error", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ guest_config: { error: { message: "boom" } } })
    );
    const res = await guestPUT(jsonReq("PUT", {}));
    expect(res.status).toBe(500);
  });

  it("GET passes the guard denial through", async () => {
    mockGuard.mockResolvedValue(denial());
    const res = await guestGET(jsonReq("GET"));
    expect(res.status).toBe(403);
  });
});

describe("password-policy route", () => {
  it("GET returns the stored policy", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ password_policy: { data: { min_length: 16, rotation_days: 30 } } })
    );
    const res = await pwGET(jsonReq("GET"));
    const body = await res.json();
    expect(body.policy.minLength).toBe(16);
  });

  it("GET falls back to defaults when no row exists", async () => {
    mockSupabase.mockReturnValue(makeSupabase({ password_policy: { data: null } }));
    const res = await pwGET(jsonReq("GET"));
    const body = await res.json();
    expect(body.policy.minLength).toBe(12);
  });

  it("PUT upserts and returns success", async () => {
    mockSupabase.mockReturnValue(makeSupabase({ password_policy: { error: null } }));
    const res = await pwPUT(jsonReq("PUT", { minLength: 14 }));
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("PUT returns 500 on upsert error", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ password_policy: { error: { message: "no" } } })
    );
    const res = await pwPUT(jsonReq("PUT", {}));
    expect(res.status).toBe(500);
  });

  it("GET passes the guard denial through", async () => {
    mockGuard.mockResolvedValue(denial());
    const res = await pwGET(jsonReq("GET"));
    expect(res.status).toBe(403);
  });
});

describe("entitlements route", () => {
  it("GET returns groups with user counts", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({
        entitlement_groups: {
          data: [{ id: "g1", code: "pro", display_name: "Pro", is_active: true }],
          error: null,
        },
        user_entitlements: {
          data: [{ entitlement_group_id: "g1" }, { entitlement_group_id: "g1" }],
        },
      })
    );
    const res = await entGET(jsonReq("GET"));
    const body = await res.json();
    expect(body.groups[0].userCount).toBe(2);
    expect(body.groups[0].displayName).toBe("Pro");
  });

  it("GET returns 500 when the group query errors", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ entitlement_groups: { data: null, error: { message: "boom" } } })
    );
    const res = await entGET(jsonReq("GET"));
    expect(res.status).toBe(500);
  });

  it("PATCH rejects a missing groupId with 400", async () => {
    const res = await entPATCH(jsonReq("PATCH", { isActive: true }));
    expect(res.status).toBe(400);
  });

  it("PATCH rejects a non-boolean isActive with 400", async () => {
    const res = await entPATCH(jsonReq("PATCH", { groupId: "g1", isActive: "yes" }));
    expect(res.status).toBe(400);
  });

  it("PATCH toggles and returns success", async () => {
    mockSupabase.mockReturnValue(makeSupabase({ entitlement_groups: { error: null } }));
    const res = await entPATCH(jsonReq("PATCH", { groupId: "g1", isActive: false }));
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("PATCH returns 500 on update error", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ entitlement_groups: { error: { message: "no" } } })
    );
    const res = await entPATCH(jsonReq("PATCH", { groupId: "g1", isActive: true }));
    expect(res.status).toBe(500);
  });

  it("GET passes the guard denial through", async () => {
    mockGuard.mockResolvedValue(denial());
    const res = await entGET(jsonReq("GET"));
    expect(res.status).toBe(403);
  });
});

describe("gdpr purge route", () => {
  beforeEach(() => {
    mockRequireAuth.mockResolvedValue({ user: { sub: "admin-1" }, accessToken: "t" });
    mockRequirePermission.mockResolvedValue({});
    MockPurgePipeline.mockImplementation(() => ({
      execute: jest.fn().mockResolvedValue({
        purgeId: "pg1",
        status: "completed",
        totalDeleted: 3,
        steps: [],
      }),
    }));
  });

  it("purges when authorized with a valid request", async () => {
    const res = await gdprPOST(jsonReq("POST", { userId: "u1", reason: "admin-action" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.purgeId).toBe("pg1");
  });

  it("returns the auth error when unauthenticated", async () => {
    const err = NextResponse.json({ error: "unauth" }, { status: 401 });
    mockRequireAuth.mockResolvedValue({ error: err });
    const res = await gdprPOST(jsonReq("POST", { userId: "u1", reason: "admin-action" }));
    expect(res.status).toBe(401);
  });

  it("returns the permission error when lacking permission", async () => {
    mockRequirePermission.mockResolvedValue({ error: denial() });
    const res = await gdprPOST(jsonReq("POST", { userId: "u1", reason: "admin-action" }));
    expect(res.status).toBe(403);
  });

  it("400s on invalid JSON", async () => {
    const res = await gdprPOST(jsonReq("POST", undefined, "{not json"));
    expect(res.status).toBe(400);
  });

  it("400s on a missing userId", async () => {
    const res = await gdprPOST(jsonReq("POST", { reason: "admin-action" }));
    expect(res.status).toBe(400);
  });

  it("400s on an invalid reason", async () => {
    const res = await gdprPOST(jsonReq("POST", { userId: "u1", reason: "nope" }));
    expect(res.status).toBe(400);
  });

  it("500s when the pipeline throws", async () => {
    MockPurgePipeline.mockImplementation(() => ({
      execute: jest.fn().mockRejectedValue(new Error("pipeline down")),
    }));
    const res = await gdprPOST(jsonReq("POST", { userId: "u1", reason: "admin-action" }));
    expect(res.status).toBe(500);
  });
});
