/**
 * __tests__/admin-ai-approvals-context.test.ts — ADR-040 040c piece 3.
 * The plan route provides pending holds as context for the approvals panel, so the model
 * can resolve "approve the strike change" to a specific proposalId (confirmed before it runs).
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
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-1",
}));
jest.mock("@/platform/ai", () => ({
  getOrchestrator: jest.fn(() => ({
    complete: jest.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  })),
}));
jest.mock("@/prompts", () => ({
  getPromptConfig: jest.fn(() => ({ tier: "standard", maxTokens: 1000, name: "admin" })),
  buildAdminSystemPrompt: jest.fn(() => "sys"),
}));
jest.mock("@/platform/admin/pending-approvals", () => ({
  listPendingApprovals: jest.fn(async () => [
    {
      source: "runtime",
      id: "p1",
      label: "config.set moderation.strike_ban_threshold",
      requester: "admin-2",
      requiredPermission: "config_manage_safety",
      reason: "held",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]),
}));

import { NextRequest } from "next/server";
import { authAs, type CallerName } from "@/__tests__/helpers/test-identities";
import { getOrchestrator } from "@/platform/ai";
import { fakeData } from "./helpers/fake-data";
import { buildAdminSystemPrompt } from "@/prompts";
import { listPendingApprovals } from "@/platform/admin/pending-approvals";
import { POST } from "@/app/api/admin/ai/route";

function plan(body: unknown, caller: CallerName = "safety_approver") {
  return POST(
    new NextRequest("http://localhost/api/admin/ai", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...authAs(caller) },
    })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  fakeData().reset();
  fakeData().answer = (sql) =>
    sql.startsWith("select name, display_name from roles")
      ? [{ name: "free", display_name: "Free" }]
      : undefined;
});

it("provides pending holds as context for the approvals panel", async () => {
  const res = await plan({
    prompt: "approve the strike-threshold change",
    panel: "approvals",
  });
  expect(res.status).toBe(200);
  expect(listPendingApprovals).toHaveBeenCalled();
  const contextArg = (buildAdminSystemPrompt as jest.Mock).mock.calls[0][1] as string;
  expect(contextArg).toContain("strike_ban_threshold");
  expect(contextArg).toContain("p1");
});

/** The tool names offered to the model on the last plan call. */
function offeredTools(): string[] {
  const orchestrator = (getOrchestrator as jest.Mock).mock.results.at(-1)!.value;
  const call = (orchestrator.complete as jest.Mock).mock.calls[0][0];
  return call.tools.map((t: { name: string }) => t.name);
}

it("offers a moderator no role or user tools, and no role data (TASK-145)", async () => {
  await plan({ prompt: "make me super admin", panel: "users" }, "moderator");
  expect(offeredTools()).not.toContain("change_user_role");
  expect((buildAdminSystemPrompt as jest.Mock).mock.calls[0][1]).toBe("");
});

it("offers a super_admin the user tools for the users panel", async () => {
  await plan({ prompt: "promote alice", panel: "users" }, "super_admin");
  expect(offeredTools()).toContain("change_user_role");
});

it.each([
  [{ prompt: "x" }],
  [{ panel: "users" }],
  [{ prompt: ["x"], panel: "users" }],
  [{ prompt: "x".repeat(4001), panel: "users" }],
])("refuses %p without calling the model", async (body) => {
  const res = await plan(body);
  expect(res.status).toBe(400);
  expect(getOrchestrator).not.toHaveBeenCalled();
});

it.each(["anonymous", "free"] as const)("refuses %s", async (caller) => {
  const res = await plan({ prompt: "x", panel: "users" }, caller);
  expect([401, 403]).toContain(res.status);
  expect(getOrchestrator).not.toHaveBeenCalled();
});

it("treats an unknown or prototype panel name as no panel", async () => {
  const res = await plan({ prompt: "x", panel: "__proto__" }, "super_admin");
  expect(res.status).toBe(200);
  expect(offeredTools()).toEqual(["search"]);
});
