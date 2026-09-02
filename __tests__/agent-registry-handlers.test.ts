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
const setConfig = jest.fn();
jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: (...a: unknown[]) => getConfig(...a),
  setConfig: (...a: unknown[]) => setConfig(...a),
}));
const writeAuditLog = jest.fn();
jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: (...a: unknown[]) => writeAuditLog(...a),
}));

const ACTOR = "admin-1";

beforeEach(() => {
  getConfig.mockReset();
  setConfig.mockReset();
  writeAuditLog.mockReset();
  setConfig.mockResolvedValue({ success: true });
  writeAuditLog.mockResolvedValue(undefined);
});

describe("handleRegisterAgent", () => {
  it("adds a new agent with defaults and writes the registry", async () => {
    getConfig.mockResolvedValue([]);
    const r = await handleRegisterAgent(
      { agent_id: "agent:x", scopes: ["translate"] },
      ACTOR
    );
    expect(r.success).toBe(true);
    const written = setConfig.mock.calls[0][1] as [string, any][];
    expect(written).toEqual([
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
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });

  it("rejects a duplicate agent", async () => {
    getConfig.mockResolvedValue([
      ["agent:x", { owner: "o", scopes: [], status: "active" }],
    ]);
    const r = await handleRegisterAgent({ agent_id: "agent:x" }, ACTOR);
    expect(r.success).toBe(false);
    expect(setConfig).not.toHaveBeenCalled();
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
    const written = setConfig.mock.calls[0][1] as [string, any][];
    expect(written[0][1].status).toBe("suspended");
  });
  it("reactivates when reactivate=true", async () => {
    const r = await handleSuspendAgent({ agent_id: "agent:x", reactivate: true }, ACTOR);
    expect(r.success).toBe(true);
    expect((setConfig.mock.calls[0][1] as any)[0][1].status).toBe("active");
  });
  it("fails on unknown agent", async () => {
    const r = await handleSuspendAgent({ agent_id: "agent:none" }, ACTOR);
    expect(r.success).toBe(false);
    expect(setConfig).not.toHaveBeenCalled();
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
    expect((setConfig.mock.calls[0][1] as any)[0][1].scopes).toEqual([
      "speak",
      "transcribe",
    ]);
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
    expect((setConfig.mock.calls[0][1] as any)[0][1].maxTokenTtl).toBe(1800);
  });
  it("rejects a non-positive ttl", async () => {
    const r = await handleSetAgentTtl({ agent_id: "agent:x", max_token_ttl: 0 }, ACTOR);
    expect(r.success).toBe(false);
    expect(setConfig).not.toHaveBeenCalled();
  });
});
