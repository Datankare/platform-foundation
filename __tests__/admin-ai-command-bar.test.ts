/**
 * __tests__/admin-ai-command-bar.test.ts — coverage remediation (ADR-040 "B", B4).
 *
 * The ai command-bar plan route (ai/route.ts), the execute route (ai/execute/route.ts),
 * and the static tool-schemas (importing the aggregator covers all eight schema files).
 */
jest.mock("@/platform/auth/admin-guard", () => ({ adminGuard: jest.fn() }));
jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-1",
}));
jest.mock("@/platform/ai", () => ({ getOrchestrator: jest.fn() }));
jest.mock("@/prompts", () => ({
  getPromptConfig: jest.fn(() => ({ tier: "standard", maxTokens: 1000, name: "admin" })),
  buildAdminSystemPrompt: jest.fn(() => "sys"),
}));
jest.mock("@/platform/agents/tool-invoker", () => ({ invokeTool: jest.fn() }));
jest.mock("@/platform/agents/trajectory-store", () => ({
  getTrajectoryStore: jest.fn(() => ({
    create: jest.fn().mockResolvedValue({ trajectory: { trajectoryId: "t1" } }),
  })),
}));
jest.mock("@/platform/agents/proposal-store", () => ({
  getProposalStore: jest.fn(() => ({})),
}));

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { getOrchestrator } from "@/platform/ai";
import { invokeTool } from "@/platform/agents/tool-invoker";

import { POST as planPOST } from "@/app/api/admin/ai/route";
import { POST as executePOST } from "@/app/api/admin/ai/execute/route";
import { SHARED_TOOLS, PANEL_TOOL_SCHEMAS } from "@/app/api/admin/ai/tool-schemas";

const mockGuard = adminGuard as jest.Mock;
const mockSupabase = getSupabaseServiceClient as jest.Mock;
const mockOrchestrator = getOrchestrator as jest.Mock;
const mockInvokeTool = invokeTool as jest.Mock;

const denial = () => NextResponse.json({ error: "forbidden" }, { status: 403 });

function makeSupabase(tableResults: Record<string, Record<string, unknown>>) {
  const from = jest.fn((table: string) => {
    const result = tableResults[table] ?? { data: [], error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: Record<string, any> = {};
    for (const m of ["select", "eq", "is", "order", "limit"]) {
      builder[m] = jest.fn(() => builder);
    }
    builder.then = (resolve: (v: unknown) => void) => resolve(result);
    return builder;
  });
  return { from };
}

function jsonReq(body: unknown, raw?: string): NextRequest {
  const serialized = raw !== undefined ? raw : JSON.stringify(body);
  return new NextRequest("http://localhost/api/admin/ai", {
    method: "POST",
    body: serialized,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGuard.mockResolvedValue(null);
  mockSupabase.mockReturnValue(makeSupabase({}));
});

describe("ai plan route", () => {
  beforeEach(() => {
    mockOrchestrator.mockReturnValue({
      complete: jest.fn().mockResolvedValue({
        content: [
          { type: "text", text: "Here is the plan" },
          { type: "tool_use", name: "create_role", input: { name: "ops" } },
        ],
      }),
    });
  });

  it("returns a plan of message + actions", async () => {
    const res = await planPOST(jsonReq({ prompt: "make a role", panel: "roles" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.message).toMatch(/Here is the plan/);
    expect(body.plan.actions[0].tool).toBe("create_role");
  });

  it("builds context for the users panel", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ users: { count: 5 }, roles: { data: [] } })
    );
    const res = await planPOST(jsonReq({ prompt: "x", panel: "users" }));
    expect(res.status).toBe(200);
  });

  it("builds context for the entitlements panel", async () => {
    const res = await planPOST(jsonReq({ prompt: "x", panel: "entitlements" }));
    expect(res.status).toBe(200);
  });

  it("400s when prompt or panel is missing", async () => {
    const res = await planPOST(jsonReq({ panel: "roles" }));
    expect(res.status).toBe(400);
  });

  it("500s when the orchestrator fails", async () => {
    mockOrchestrator.mockReturnValue({
      complete: jest.fn().mockRejectedValue(new Error("down")),
    });
    const res = await planPOST(jsonReq({ prompt: "x", panel: "roles" }));
    expect(res.status).toBe(500);
  });

  it("passes the guard denial through", async () => {
    mockGuard.mockResolvedValue(denial());
    const res = await planPOST(jsonReq({ prompt: "x", panel: "roles" }));
    expect(res.status).toBe(403);
  });
});

describe("ai execute route", () => {
  it("runs an action through the governed runtime", async () => {
    mockInvokeTool.mockResolvedValue({ output: { success: true, result: "done" } });
    const body = {
      actions: [{ tool: "create_role", input: { name: "ops" } }],
      prompt: "x",
    };
    const res = await executePOST(jsonReq(body));
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.results[0].success).toBe(true);
    expect(parsed.results[0].result).toBe("done");
  });

  it("400s when actions is not an array", async () => {
    const res = await executePOST(jsonReq({ actions: "nope" }));
    expect(res.status).toBe(400);
  });

  it("reports an unknown tool and stops", async () => {
    const res = await executePOST(jsonReq({ actions: [{ tool: "bogus" }] }));
    const parsed = await res.json();
    expect(parsed.results[0].success).toBe(false);
    expect(parsed.results[0].error).toMatch(/Unknown tool/);
  });

  it("captures an invokeTool failure", async () => {
    mockInvokeTool.mockRejectedValue(new Error("gated"));
    const body = { actions: [{ tool: "create_role", input: {} }] };
    const res = await executePOST(jsonReq(body));
    const parsed = await res.json();
    expect(parsed.results[0].success).toBe(false);
  });

  it("passes the guard denial through", async () => {
    mockGuard.mockResolvedValue(denial());
    const res = await executePOST(jsonReq({ actions: [] }));
    expect(res.status).toBe(403);
  });
});

describe("tool-schemas", () => {
  it("SHARED_TOOLS includes the search tool", () => {
    expect(SHARED_TOOLS.some((t) => t.name === "search")).toBe(true);
  });

  it("every panel tool is well-formed", () => {
    const all = Object.values(PANEL_TOOL_SCHEMAS).flat();
    expect(all.length).toBeGreaterThan(0);
    for (const tool of all) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.input_schema).toBeDefined();
    }
  });
});
