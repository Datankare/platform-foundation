/**
 * __tests__/agent-registry-handlers.test.ts — U4 registry handler tests (Sprint 3c).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  handleRegisterAgent,
  handleSuspendAgent,
  handleSetAgentScope,
  handleSetAgentTtl,
} from "@/app/api/admin/ai/handlers/agents";

const getConfig = jest.fn();
const writeGovernedConfig = jest.fn();
jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: (...a: unknown[]) => getConfig(...a),
  // The registry is read with getConfigOrThrow (audit B-21).
  getConfigOrThrow: (...a: unknown[]) => getConfig(...a),
}));
jest.mock("@/platform/admin/governed-config", () => ({
  ...jest.requireActual("@/platform/admin/governed-config"),
  writeGovernedConfig: (...a: unknown[]) => writeGovernedConfig(...a),
}));

/** The verified admin the command bar passes; the governed write checks its tier permission. */
const ACTOR = {
  userId: "00000000-0000-4000-8000-00000000a001",
  sub: "sub-admin",
  roleName: "admin",
  permissions: ["admin_manage_agents", "admin_manage_config", "config_manage_safety"],
};
/** The value the handler asked the governed write to store. */
const written = (n = 0): any => writeGovernedConfig.mock.calls[n][1].value;

beforeEach(() => {
  getConfig.mockReset();
  writeGovernedConfig.mockReset();
  writeGovernedConfig.mockResolvedValue({ kind: "applied", result: {} });
});

describe("handleRegisterAgent", () => {
  it("adds a new agent with defaults and writes the registry", async () => {
    getConfig.mockResolvedValue([]);
    const r = await handleRegisterAgent(
      { agent_id: "agent:x", scopes: ["translate"] },
      ACTOR
    );
    expect(r.success).toBe(true);
    expect(written()).toEqual([
      [
        "agent:x",
        {
          owner: "first-party",
          scopes: ["translate"],
          status: "active",
          maxTokenTtl: 300,
        },
      ],
    ]);
    expect(writeGovernedConfig).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({ changeComment: expect.stringMatching(/^Command bar: /) })
    );
  });

  it("rejects a duplicate agent", async () => {
    getConfig.mockResolvedValue([
      ["agent:x", { owner: "o", scopes: [], status: "active" }],
    ]);
    const r = await handleRegisterAgent({ agent_id: "agent:x" }, ACTOR);
    expect(r.success).toBe(false);
    expect(writeGovernedConfig).not.toHaveBeenCalled();
  });

  it("requires agent_id", async () => {
    const r = await handleRegisterAgent({}, ACTOR);
    expect(r.success).toBe(false);
  });
});

describe("handleSuspendAgent", () => {
  beforeEach(() =>
    getConfig.mockResolvedValue([
      [
        "agent:x",
        { owner: "o", scopes: ["translate"], status: "active", maxTokenTtl: 300 },
      ],
    ])
  );
  it("suspends an active agent", async () => {
    const r = await handleSuspendAgent({ agent_id: "agent:x" }, ACTOR);
    expect(r.success).toBe(true);
    expect(written()[0][1].status).toBe("suspended");
  });
  it("reactivates when reactivate=true", async () => {
    const r = await handleSuspendAgent({ agent_id: "agent:x", reactivate: true }, ACTOR);
    expect(r.success).toBe(true);
    expect(written()[0][1].status).toBe("active");
  });
  it("fails on unknown agent", async () => {
    const r = await handleSuspendAgent({ agent_id: "agent:none" }, ACTOR);
    expect(r.success).toBe(false);
    expect(writeGovernedConfig).not.toHaveBeenCalled();
  });
});

describe("handleSetAgentScope", () => {
  beforeEach(() =>
    getConfig.mockResolvedValue([
      [
        "agent:x",
        { owner: "o", scopes: ["translate"], status: "active", maxTokenTtl: 300 },
      ],
    ])
  );
  it("replaces the scope set", async () => {
    const r = await handleSetAgentScope(
      { agent_id: "agent:x", scopes: ["speak", "transcribe"] },
      ACTOR
    );
    expect(r.success).toBe(true);
    expect(written()[0][1].scopes).toEqual(["speak", "transcribe"]);
  });
  it("fails on unknown agent", async () => {
    const r = await handleSetAgentScope({ agent_id: "agent:none", scopes: [] }, ACTOR);
    expect(r.success).toBe(false);
  });
});

describe("handleSetAgentTtl", () => {
  beforeEach(() =>
    getConfig.mockResolvedValue([
      ["agent:x", { owner: "o", scopes: [], status: "active", maxTokenTtl: 300 }],
    ])
  );
  it("sets a positive ceiling", async () => {
    const r = await handleSetAgentTtl(
      { agent_id: "agent:x", max_token_ttl: 1800 },
      ACTOR
    );
    expect(r.success).toBe(true);
    expect(written()[0][1].maxTokenTtl).toBe(1800);
  });
  it("rejects a non-positive ttl", async () => {
    const r = await handleSetAgentTtl({ agent_id: "agent:x", max_token_ttl: 0 }, ACTOR);
    expect(r.success).toBe(false);
    expect(writeGovernedConfig).not.toHaveBeenCalled();
  });
});

describe("an unreadable or malformed registry is never overwritten (audit B-21)", () => {
  it.each([
    ["unreadable", () => getConfig.mockRejectedValue(new Error("db down"))],
    ["not a list", () => getConfig.mockResolvedValue({ a: 1 })],
    [
      "a list of the wrong shape",
      () => getConfig.mockResolvedValue([["agent:a", "oops"]]),
    ],
    [
      "stored as JSON text",
      () => getConfig.mockResolvedValue('[["agent:a",{"scopes":[]}]]'),
    ],
  ])("refuses every change when the registry is %s", async (_l, arrange) => {
    arrange();
    for (const run of [
      () => handleRegisterAgent({ agent_id: "agent:new" }, ACTOR),
      () => handleSuspendAgent({ agent_id: "agent:a" }, ACTOR),
      () => handleSetAgentScope({ agent_id: "agent:a", scopes: ["*"] }, ACTOR),
      () => handleSetAgentTtl({ agent_id: "agent:a", max_token_ttl: 60 }, ACTOR),
    ]) {
      const r = await run();
      expect(r).toMatchObject({
        success: false,
        error: expect.stringMatching(/could not be read/),
      });
    }
    expect(writeGovernedConfig).not.toHaveBeenCalled();
  });

  it("keeps every other agent when one is registered", async () => {
    getConfig.mockResolvedValue([
      ["agent:a", { owner: "o", scopes: ["x"], status: "active" }],
      ["agent:b", { owner: "o", scopes: [], status: "suspended" }],
    ]);
    await handleRegisterAgent({ agent_id: "agent:c" }, ACTOR);
    expect(written().map(([id]: [string]) => id)).toEqual([
      "agent:a",
      "agent:b",
      "agent:c",
    ]);
  });
});
