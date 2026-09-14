/**
 * __tests__/admin-thin-routes.test.ts — coverage remediation (ADR-040 "B").
 *
 * The five thin read-only governance GET routes: each is adminGuard-gated and returns a
 * JSON view. Covers authorized, guard-denied passthrough, and the shape-coercion / error
 * branches so the final coverage flip lands above the branch floor.
 */
jest.mock("@/platform/auth/admin-guard", () => ({ adminGuard: jest.fn() }));
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

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { getConfig } from "@/platform/auth/platform-config";
import { getApprovalPolicyStore } from "@/platform/agents";
import { getSupabaseServiceClient } from "@/lib/supabase/server";

import { GET as agentRegistryGET } from "@/app/api/admin/agent-registry/route";
import { GET as approvalPolicyGET } from "@/app/api/admin/approval-policy/route";
import { GET as capabilitiesGET } from "@/app/api/admin/capabilities/route";
import { GET as capabilityMappingGET } from "@/app/api/admin/capability-mapping/route";
import { GET as perAccountGET } from "@/app/api/admin/per-account/route";

const mockGuard = adminGuard as jest.Mock;
const mockConfig = getConfig as jest.Mock;
const mockPolicyStore = getApprovalPolicyStore as jest.Mock;
const mockSupabase = getSupabaseServiceClient as jest.Mock;

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}
const denial = () => NextResponse.json({ error: "forbidden" }, { status: 403 });

function supa(result: { data: unknown; error: { message: string } | null }) {
  const limit = () => Promise.resolve(result);
  return { from: () => ({ select: () => ({ order: () => ({ limit }) }) }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGuard.mockResolvedValue(null);
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
  it("passes the guard denial through", async () => {
    mockGuard.mockResolvedValue(denial());
    expect((await agentRegistryGET(req("/api/admin/agent-registry"))).status).toBe(403);
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
  it("passes the guard denial through", async () => {
    mockGuard.mockResolvedValue(denial());
    expect((await approvalPolicyGET(req("/api/admin/approval-policy"))).status).toBe(403);
  });
});

describe("GET /api/admin/capabilities", () => {
  it("returns the built capabilities document", async () => {
    const res = await capabilitiesGET(req("/api/admin/capabilities"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ capabilities: [] });
  });
  it("passes the guard denial through", async () => {
    mockGuard.mockResolvedValue(denial());
    expect((await capabilitiesGET(req("/api/admin/capabilities"))).status).toBe(403);
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
  it("passes the guard denial through", async () => {
    mockGuard.mockResolvedValue(denial());
    expect(
      (await capabilityMappingGET(req("/api/admin/capability-mapping"))).status
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
  it("passes the guard denial through", async () => {
    mockGuard.mockResolvedValue(denial());
    expect((await perAccountGET(req("/api/admin/per-account"))).status).toBe(403);
  });
});
