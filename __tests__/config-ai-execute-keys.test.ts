/**
 * @jest-environment node
 */
/**
 * __tests__/config-ai-execute-keys.test.ts — the config assistant's tools take only their own
 * input keys (TASK-194 round 10, I-A)
 *
 * A held config change records its input as its hold's payload and its proposal step's input; a key
 * outside the tool's schema is refused, coded, before anything runs or is held — never dropped
 * silently, never stored. The keys the route itself sets from the verified admin (actorId,
 * reviewerId and the operator flags) are the route's, whatever the caller sent.
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
const mockDispatch = jest.fn();
jest.mock("@/platform/admin/config-handlers", () => ({
  ...jest.requireActual("@/platform/admin/config-handlers"),
  dispatchConfigTool: (...args: unknown[]) => mockDispatch(...args),
}));
jest.mock("@/platform/auth/platform-config", () => ({
  ...jest.requireActual("@/platform/auth/platform-config"),
  getPermissionTier: async () => "standard",
}));

import { NextRequest } from "next/server";
import { authAs } from "@/__tests__/helpers/test-identities";
import { POST } from "@/app/api/admin/config-ai/execute/route";

const call = (toolId: string, input: Record<string, unknown>) =>
  POST(
    new NextRequest("http://localhost/api/admin/config-ai/execute", {
      method: "POST",
      headers: { "content-type": "application/json", ...authAs("super_admin") },
      body: JSON.stringify({ toolId, input }),
    })
  );

beforeEach(() => {
  mockDispatch.mockReset().mockResolvedValue({
    toolId: "update_config",
    success: true,
    data: {},
    durationMs: 0,
  });
});

it("refuses a key outside the tool's schema, coded; nothing runs (round 10, I-A)", async () => {
  const res = await call("update_config", {
    key: "moderation.strike_ban_threshold",
    value: 3,
    changeComment: "raise",
    why: "she posted her address",
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({
    code: "request.unknown_input",
    params: {
      field: "why",
      allowed: ["key", "value", "changeComment", "actorId", "confirmed", "scope"],
    },
  });
  expect(mockDispatch).not.toHaveBeenCalled();
});

it("takes the tool's own keys (and sets the actor itself)", async () => {
  const res = await call("update_config", {
    key: "moderation.strike_ban_threshold",
    value: 3,
    changeComment: "raise",
  });
  expect(res.status).toBe(200);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
});

// The self-check of round 10: the one screen that calls this route (DualControlKeysPanel) sends
// `confirmed: true` — P10's apply-not-preview flag, which update_config and reset_config read — so
// the schemas name it; a key check that refused it would have broken that screen.
it.each([
  [
    "update_config",
    {
      key: "config.dual_control_keys",
      value: ["moderation.strike_ban_threshold"],
      changeComment: "add a key",
      confirmed: true,
    },
  ],
  [
    "reset_config",
    { key: "config.dual_control_keys", changeComment: "reset", confirmed: true },
  ],
])(
  "takes P10's confirmed flag on %s (the panel's own request)",
  async (toolId, input) => {
    const res = await call(toolId, input);
    expect(res.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][1]).toMatchObject({ confirmed: true });
  }
);

// Round 11, item 2: `scope` is read by update_config and request_approval (where the change goes),
// so their schemas name it; the keys the route and dispatchConfigTool set are no input, and a
// caller's is refused — never dispatched.
it.each([
  [
    "update_config",
    { key: "moderation.strike_ban_threshold", value: 3, changeComment: "c" },
  ],
  [
    "request_approval",
    {
      configKey: "moderation.strike_ban_threshold",
      proposedValue: 3,
      changeComment: "c",
    },
  ],
])("takes scope on %s, and passes it on", async (toolId, input) => {
  const res = await call(toolId, { ...input, scope: "tenant" });
  expect(res.status).toBe(200);
  expect(mockDispatch.mock.calls[0][1]).toMatchObject({ scope: "tenant" });
});

// Round 12, nit 1: a key the server sets for the tool is the server's —
// request.field_not_accepted; one it sets for another tool is simply no input here.
it.each([
  ["heldPrevious", { value: 1 }, "request.field_not_accepted"],
  ["expectPrevious", { value: 1 }, "request.field_not_accepted"],
  ["actorIsOperator", true, "request.field_not_accepted"],
  ["reviewerIsOperator", true, "request.unknown_input"],
])("refuses %s from a caller on update_config (%#)", async (field, value, code) => {
  const res = await call("update_config", {
    key: "moderation.strike_ban_threshold",
    value: 3,
    changeComment: "c",
    [field]: value,
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code, params: { field } });
  expect(mockDispatch).not.toHaveBeenCalled();
});

it("a config entry's value is its own shape: keys inside it are the entry's, not checked", async () => {
  const res = await call("update_config", {
    key: "agent.trusted_agents",
    value: [["agent:a", { owner: "o", scopes: ["x"], status: "active" }]],
    changeComment: "c",
  });
  expect(res.status).toBe(200);
});
