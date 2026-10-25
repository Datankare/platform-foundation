/**
 * __tests__/admin-thin-routes.test.ts — coverage remediation (ADR-040 "B").
 *
 * The thin read-only governance GET routes: each is adminGuard-gated and returns a JSON view.
 * (GET /api/admin/per-account reads the database: tested against Postgres in
 * __tests__/db/admin-tenant-data.db.test.ts.) The guard is real (helpers/test-identities.ts): authorized as super_admin, refused
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
jest.mock("@/platform/auth/platform-config", () => ({ getConfigOrThrow: jest.fn() }));
jest.mock("@/platform/agents", () => ({
  getApprovalPolicyStore: jest.fn(),
  listWorkflows: jest.fn(() => []),
  buildCapabilities: jest.fn(() => ({ capabilities: [] })),
}));
jest.mock("@/platform/providers/registry", () => ({
  getActiveProviders: jest.fn(() => ({})),
}));

import { NextRequest } from "next/server";
import { authAs, type CallerName } from "@/__tests__/helpers/test-identities";
import { getConfigOrThrow } from "@/platform/auth/platform-config";
import { getApprovalPolicyStore } from "@/platform/agents";

import { GET as agentRegistryGET } from "@/app/api/admin/agent-registry/route";
import { GET as approvalPolicyGET } from "@/app/api/admin/approval-policy/route";
import { GET as capabilitiesGET } from "@/app/api/admin/capabilities/route";
import { GET as capabilityMappingGET } from "@/app/api/admin/capability-mapping/route";

const mockConfig = getConfigOrThrow as jest.Mock;
const mockPolicyStore = getApprovalPolicyStore as jest.Mock;

function req(path: string, caller: CallerName = "super_admin"): NextRequest {
  return new NextRequest(`http://localhost${path}`, { headers: authAs(caller) });
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
  it.each([
    ["a string", "nope"],
    ["null", null],
    ["an object", { a1: {} }],
    ["an entry not a pair", [["a1"]]],
    ["an id not a string", [[1, {}]]],
    ["an empty id", [["", {}]]],
    ["a record not an object", [["a1", "active"]]],
    ["a record that is a list", [["a1", []]]],
    [
      "an id twice",
      [
        ["a1", {}],
        ["a1", {}],
      ],
    ],
  ])(
    "answers 503 for a malformed stored registry (%s) — never an empty list (review 14 L-1)",
    async (_label, stored) => {
      mockConfig.mockResolvedValue(stored);
      const res = await agentRegistryGET(req("/api/admin/agent-registry"));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "service.unavailable" });
    }
  );
  it("an empty registry is shown empty", async () => {
    mockConfig.mockResolvedValue([]);
    const res = await agentRegistryGET(req("/api/admin/agent-registry"));
    expect(res.status).toBe(200);
    expect((await res.json()).agents).toEqual([]);
  });
  it("answers 503 when the registry cannot be read — never an empty list (review 13 P)", async () => {
    mockConfig.mockRejectedValue(new Error("config store down"));
    const res = await agentRegistryGET(req("/api/admin/agent-registry"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "service.unavailable" });
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
  it.each([
    ["null", null],
    ["a string", "translate"],
    ["an object", { translate: ["translate"] }],
    ["an entry not a pair", [["translate"]]],
    ["features not a list", [["translate", "translate"]]],
    ["features not strings", [["translate", [1]]]],
    [
      "a capability twice",
      [
        ["translate", []],
        ["translate", ["translate"]],
      ],
    ],
  ])(
    "answers 503 for a malformed stored map (%s) — never an empty list (review 14 L-1)",
    async (_label, stored) => {
      mockConfig.mockResolvedValue(stored);
      const res = await capabilityMappingGET(req("/api/admin/capability-mapping"));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "service.unavailable" });
    }
  );
  it("an empty map is shown empty", async () => {
    mockConfig.mockResolvedValue([]);
    const res = await capabilityMappingGET(req("/api/admin/capability-mapping"));
    expect(res.status).toBe(200);
    expect((await res.json()).mappings).toEqual([]);
  });
  it("answers 503 when the map cannot be read — never an empty list (review 13 P)", async () => {
    mockConfig.mockRejectedValue(new Error("config store down"));
    const res = await capabilityMappingGET(req("/api/admin/capability-mapping"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "service.unavailable" });
  });
  it("refuses a moderator, who lacks the page's permission", async () => {
    expect(
      (await capabilityMappingGET(req("/api/admin/capability-mapping", "moderator")))
        .status
    ).toBe(403);
  });
});
