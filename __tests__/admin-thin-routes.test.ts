/**
 * __tests__/admin-thin-routes.test.ts — coverage remediation (ADR-040 "B").
 *
 * The five thin read-only governance GET routes: each is adminGuard-gated and returns a
 * JSON view. The guard is real (helpers/test-identities.ts): authorized as super_admin, refused
 * as a moderator, plus the shape-coercion and error branches.
 */
jest.mock("@/platform/auth/middleware", () =>
  require("@/__tests__/helpers/test-identities").mockMiddleware()
);
jest.mock("@/platform/auth/permissions-cache", () =>
  require("@/__tests__/helpers/test-identities").mockPermissionsCache()
);
jest.mock("@/platform/auth/account-status-guard", () =>
  require("@/__tests__/helpers/test-identities").mockAccountStatus()
);
jest.mock("@/platform/rate-limit", () =>
  require("@/__tests__/helpers/test-identities").mockRateLimit()
);
jest.mock("@/platform/auth/platform-config", () => ({ getConfig: jest.fn() }));
jest.mock("@/platform/agents", () => ({
  getApprovalPolicyStore: jest.fn(),
  listWorkflows: jest.fn(() => []),
  buildCapabilities: jest.fn(() => ({ capabilities: [] })),
}));
jest.mock("@/platform/providers/registry", () => ({
  getActiveProviders: jest.fn(() => ({})),
}));
jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));

import { NextRequest } from "next/server";
import { authAs, type CallerName } from "@/__tests__/helpers/test-identities";
import { getConfig } from "@/platform/auth/platform-config";
import { getApprovalPolicyStore } from "@/platform/agents";
import { getSupabaseServiceClient } from "@/lib/supabase/server";

import { GET as agentRegistryGET } from "@/app/api/admin/agent-registry/route";
import { GET as approvalPolicyGET } from "@/app/api/admin/approval-policy/route";
import { GET as capabilitiesGET } from "@/app/api/admin/capabilities/route";
import { GET as capabilityMappingGET } from "@/app/api/admin/capability-mapping/route";
import { GET as perAccountGET } from "@/app/api/admin/per-account/route";

const mockConfig = getConfig as jest.Mock;
const mockPolicyStore = getApprovalPolicyStore as jest.Mock;
const mockSupabase = getSupabaseServiceClient as jest.Mock;

function req(path: string, caller: CallerName = "super_admin"): NextRequest {
  return new NextRequest(`http://localhost${path}`, { headers: authAs(caller) });
}

function supa(result: { data: unknown; error: { message: string } | null }) {
  const limit = () => Promise.resolve(result);
  return { from: () => ({ select: () => ({ order: () => ({ limit }) }) }) };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/admin/agent-registry", () => {
  it("returns the trusted-agent list when authorized", async () => {
    mockConfig.mockResolvedValue([["a1", {}]]);
    const res = await agentRegistryGET(req("/api/admin/agent-registry"));
    expect(res.status).toBe(200);
    expect((await res.json()).agents).toHaveLength(1);
  });
  it("coerces a non-array config to an empty list", async () => {
    mockConfig.mockResolvedValue("nope");
    const res = await agentRegistryGET(req("/api/admin/agent-registry"));
    expect((await res.json()).agents).toEqual([]);
  });
  it("refuses a moderator, who lacks the page's permission", async () => {
    expect(
      (await agentRegistryGET(req("/api/admin/agent-registry", "moderator"))).status
    ).toBe(403);
  });
});

describe("GET /api/admin/approval-policy", () => {
  it("returns the loaded policy", async () => {
    mockPolicyStore.mockReturnValue({
      load: jest.fn().mockResolvedValue({ version: 3, rules: [] }),
    });
    const res = await approvalPolicyGET(req("/api/admin/approval-policy"));
    expect((await res.json()).policy.version).toBe(3);
  });
  it("refuses a moderator, who lacks the page's permission", async () => {
    expect(
      (await approvalPolicyGET(req("/api/admin/approval-policy", "moderator"))).status
    ).toBe(403);
  });
});

describe("GET /api/admin/capabilities", () => {
  it("returns the built capabilities document", async () => {
    const res = await capabilitiesGET(req("/api/admin/capabilities"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ capabilities: [] });
  });
  it("refuses a moderator, who lacks the page's permission", async () => {
    expect(
      (await capabilitiesGET(req("/api/admin/capabilities", "moderator"))).status
    ).toBe(403);
  });
});

describe("GET /api/admin/capability-mapping", () => {
  it("returns the mapping pairs", async () => {
    mockConfig.mockResolvedValue([["cap", ["feat"]]]);
    const res = await capabilityMappingGET(req("/api/admin/capability-mapping"));
    expect((await res.json()).mappings).toHaveLength(1);
  });
  it("coerces a non-array config to an empty list", async () => {
    mockConfig.mockResolvedValue(null);
    const res = await capabilityMappingGET(req("/api/admin/capability-mapping"));
    expect((await res.json()).mappings).toEqual([]);
  });
  it("refuses a moderator, who lacks the page's permission", async () => {
    expect(
      (await capabilityMappingGET(req("/api/admin/capability-mapping", "moderator")))
        .status
    ).toBe(403);
  });
});

describe("GET /api/admin/per-account", () => {
  it("returns restriction rows when authorized", async () => {
    mockSupabase.mockReturnValue(supa({ data: [{ user_id: "u1" }], error: null }));
    const res = await perAccountGET(req("/api/admin/per-account"));
    expect(res.status).toBe(200);
    expect((await res.json()).restrictions).toHaveLength(1);
  });
  it("returns 500 on a query error", async () => {
    mockSupabase.mockReturnValue(supa({ data: null, error: { message: "boom" } }));
    expect((await perAccountGET(req("/api/admin/per-account"))).status).toBe(500);
  });
  it("defaults null data to an empty list", async () => {
    mockSupabase.mockReturnValue(supa({ data: null, error: null }));
    const res = await perAccountGET(req("/api/admin/per-account"));
    expect((await res.json()).restrictions).toEqual([]);
  });
  it("refuses a moderator, who lacks the page's permission", async () => {
    expect((await perAccountGET(req("/api/admin/per-account", "moderator"))).status).toBe(
      403
    );
  });
});
