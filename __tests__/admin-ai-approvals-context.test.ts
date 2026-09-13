/**
 * __tests__/admin-ai-approvals-context.test.ts — ADR-040 040c piece 3.
 * The plan route provides pending holds as context for the approvals panel, so the model
 * can resolve "approve the strike change" to a specific proposalId (confirmed before it runs).
 */
jest.mock("@/platform/auth/admin-guard", () => ({
  adminGuard: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));
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
import { buildAdminSystemPrompt } from "@/prompts";
import { listPendingApprovals } from "@/platform/admin/pending-approvals";
import { POST } from "@/app/api/admin/ai/route";

it("provides pending holds as context for the approvals panel", async () => {
  const req = new NextRequest("http://localhost/api/admin/ai", {
    method: "POST",
    body: JSON.stringify({
      prompt: "approve the strike-threshold change",
      panel: "approvals",
    }),
    headers: { "content-type": "application/json" },
  });
  const res = await POST(req);
  expect(res.status).toBe(200);
  expect(listPendingApprovals).toHaveBeenCalled();
  const contextArg = (buildAdminSystemPrompt as jest.Mock).mock.calls[0][1] as string;
  expect(contextArg).toContain("strike_ban_threshold");
  expect(contextArg).toContain("p1");
});
