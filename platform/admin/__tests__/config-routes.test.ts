/**
 * platform/admin/__tests__/config-routes.test.ts
 *
 * Tests for the config AI routes and enhanced config route.
 * Covers permission tier routing, tool execution dispatch,
 * and conversation endpoint structure.
 */

// ── Mocks ───────────────────────────────────────────────────────────────

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

jest.mock("@/platform/auth/admin-guard", () => ({
  adminGuard: jest.fn().mockResolvedValue(null),
  getAdminActorId: jest.fn().mockReturnValue("admin-test-1"),
}));

jest.mock("@/platform/auth/platform-config", () => ({
  listConfig: jest.fn().mockResolvedValue([]),
  setConfig: jest.fn().mockResolvedValue({ success: true }),
  deleteConfig: jest.fn().mockResolvedValue({ success: true }),
  listEnhancedConfig: jest.fn().mockResolvedValue([]),
  getPermissionTier: jest.fn().mockResolvedValue("standard"),
}));

jest.mock("@/platform/admin/config-handlers", () => ({
  dispatchConfigTool: jest.fn().mockResolvedValue({
    toolId: "search_config",
    success: true,
    data: { entries: [], count: 0 },
    durationMs: 5,
  }),
  CONFIG_TOOLS: [],
}));

jest.mock("@/platform/admin/config-approval", () => ({
  isApprovalRequired: jest.fn().mockResolvedValue(false),
}));

jest.mock("@/prompts/admin/config-manager-v1", () => ({
  buildConfigManagerPrompt: jest.fn().mockReturnValue("system prompt"),
  buildConfigAgentIdentity: jest.fn().mockReturnValue({
    actorType: "agent",
    actorId: "config-manager-test",
    agentRole: "config-manager",
    onBehalfOf: "admin-test-1",
  }),
  CONFIG_MANAGER_V1: {
    name: "config-manager",
    version: 1,
    tier: "standard",
    maxTokens: 2048,
    temperature: 0.2,
    agentRole: "config-manager",
  },
}));

jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: jest.fn(),
}));

jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: jest.fn(),
}));

// ── Imports ─────────────────────────────────────────────────────────────

import { NextRequest } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { getPermissionTier } from "@/platform/auth/platform-config";
import { dispatchConfigTool } from "@/platform/admin/config-handlers";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>, method = "POST"): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/admin/config-ai/execute"), {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function makeGetRequest(params?: Record<string, string>): NextRequest {
  const url = new URL("http://localhost:3000/api/admin/config");
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  return new NextRequest(url, { method: "GET" });
}

// ═══════════════════════════════════════════════════════════════════════
// Config AI Execute Route
// ═══════════════════════════════════════════════════════════════════════

describe("/api/admin/config-ai/execute", () => {
  let executeHandler: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import("@/app/api/admin/config-ai/execute/route");
    executeHandler = mod.POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (adminGuard as jest.Mock).mockResolvedValue(null);
  });

  it("dispatches a read tool with config_view permission", async () => {
    const req = makeRequest({ toolId: "search_config", input: { query: "rate" } });
    const res = await executeHandler(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(adminGuard).toHaveBeenCalledWith(expect.anything(), "config_view");
  });

  it("checks safety permission for write tools on safety-tier keys", async () => {
    (getPermissionTier as jest.Mock).mockResolvedValue("safety");

    const req = makeRequest({
      toolId: "update_config",
      input: { key: "moderation.level1.block_severity", value: "high" },
    });
    await executeHandler(req);

    // Should check config_manage_standard first, then config_manage_safety
    expect(adminGuard).toHaveBeenCalledWith(expect.anything(), "config_manage_standard");
    expect(adminGuard).toHaveBeenCalledWith(expect.anything(), "config_manage_safety");
  });

  it("returns 400 for missing toolId", async () => {
    const req = makeRequest({ input: {} });
    const res = await executeHandler(req);

    expect(res.status).toBe(400);
  });

  it("returns 422 when tool execution fails", async () => {
    (dispatchConfigTool as jest.Mock).mockResolvedValue({
      toolId: "update_config",
      success: false,
      data: null,
      error: "Validation failed",
      durationMs: 3,
    });

    const req = makeRequest({
      toolId: "update_config",
      input: { key: "k1", value: "bad" },
    });
    const res = await executeHandler(req);

    expect(res.status).toBe(422);
  });

  it("requires config_manage_safety for approval tools", async () => {
    const req = makeRequest({
      toolId: "approve_change",
      input: { approvalId: "apr-1", reviewComment: "ok" },
    });
    await executeHandler(req);

    expect(adminGuard).toHaveBeenCalledWith(expect.anything(), "config_manage_safety");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Config AI Conversation Route
// ═══════════════════════════════════════════════════════════════════════

describe("/api/admin/config-ai", () => {
  let conversationHandler: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import("@/app/api/admin/config-ai/route");
    conversationHandler = mod.POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (adminGuard as jest.Mock).mockResolvedValue(null);
  });

  it("returns structured response with trajectory", async () => {
    const req = makeRequest({ message: "Show me all moderation config" });
    const res = await conversationHandler(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.response).toBeTruthy();
    expect(data.trajectoryId).toMatch(/^traj-/);
    expect(data.agentId).toBeTruthy();
    expect(data.steps).toBeDefined();
    expect(Array.isArray(data.toolResults)).toBe(true);
  });

  it("returns 400 for missing message", async () => {
    const req = makeRequest({});
    const res = await conversationHandler(req);

    expect(res.status).toBe(400);
  });

  it("requires config_view permission", async () => {
    const req = makeRequest({ message: "hello" });
    await conversationHandler(req);

    expect(adminGuard).toHaveBeenCalledWith(expect.anything(), "config_view");
  });

  it("returns 403 when permission denied", async () => {
    const { NextResponse } = await import("next/server");
    (adminGuard as jest.Mock).mockResolvedValue(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const req = makeRequest({ message: "hello" });
    const res = await conversationHandler(req);

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Enhanced Config Route
// ═══════════════════════════════════════════════════════════════════════

describe("/api/admin/config (enhanced)", () => {
  let getHandler: (req: NextRequest) => Promise<Response>;
  let putHandler: (req: NextRequest) => Promise<Response>;
  let deleteHandler: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import("@/app/api/admin/config/route");
    getHandler = mod.GET;
    putHandler = mod.PUT;
    deleteHandler = mod.DELETE;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (adminGuard as jest.Mock).mockResolvedValue(null);
  });

  describe("GET", () => {
    it("uses config_view permission", async () => {
      const req = makeGetRequest();
      await getHandler(req);

      expect(adminGuard).toHaveBeenCalledWith(expect.anything(), "config_view");
    });

    it("returns enhanced entries when enhanced=true", async () => {
      const req = makeGetRequest({ enhanced: "true" });
      const res = await getHandler(req);
      const data = await res.json();

      expect(data.enhanced).toBe(true);
    });

    it("returns simple entries by default", async () => {
      const req = makeGetRequest();
      const res = await getHandler(req);
      const data = await res.json();

      expect(data.enhanced).toBeUndefined();
    });
  });

  describe("PUT — permission tier routing", () => {
    it("requires config_manage_standard for standard-tier keys", async () => {
      (getPermissionTier as jest.Mock).mockResolvedValue("standard");

      const req = makeRequest({ key: "rate_limit_rpm", value: 200 }, "PUT");
      await putHandler(req);

      expect(adminGuard).toHaveBeenCalledWith(
        expect.anything(),
        "config_manage_standard"
      );
    });

    it("requires config_manage_safety for safety-tier keys", async () => {
      (getPermissionTier as jest.Mock).mockResolvedValue("safety");

      const req = makeRequest(
        { key: "moderation.level1.block_severity", value: "high" },
        "PUT"
      );
      await putHandler(req);

      expect(adminGuard).toHaveBeenCalledWith(expect.anything(), "config_manage_safety");
    });

    it("returns 400 for missing key", async () => {
      const req = makeRequest({ value: "x" }, "PUT");
      const res = await putHandler(req);

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE", () => {
    it("requires config_manage_safety permission", async () => {
      const req = makeRequest({ key: "test_key" }, "DELETE");
      await deleteHandler(req);

      expect(adminGuard).toHaveBeenCalledWith(expect.anything(), "config_manage_safety");
    });
  });
});
