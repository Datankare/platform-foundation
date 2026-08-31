/**
 * __tests__/capability-mapping-handler.test.ts — U3 capability-mapping handler (Sprint 3c).
 */

import { handleSetCapabilityMapping } from "@/app/api/admin/ai/handlers/mapping";

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

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("handleSetCapabilityMapping", () => {
  it("adds a new capability mapping", async () => {
    getConfig.mockResolvedValue([["translate", ["translate"]]]);
    const r = await handleSetCapabilityMapping(
      { capability: "summarize", features: ["translate", "speak"] },
      ACTOR
    );
    expect(r.success).toBe(true);
    const written = setConfig.mock.calls[0][1] as [string, string[]][];
    expect(written).toContainEqual(["summarize", ["translate", "speak"]]);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });

  it("replaces an existing capability's feature list", async () => {
    getConfig.mockResolvedValue([["translate", ["translate"]]]);
    await handleSetCapabilityMapping(
      { capability: "translate", features: ["translate", "tts"] },
      ACTOR
    );
    const written = setConfig.mock.calls[0][1] as [string, string[]][];
    expect(written).toEqual([["translate", ["translate", "tts"]]]);
  });

  it("removes a mapping when remove=true", async () => {
    getConfig.mockResolvedValue([
      ["translate", ["translate"]],
      ["speak", ["speak"]],
    ]);
    const r = await handleSetCapabilityMapping(
      { capability: "speak", remove: true },
      ACTOR
    );
    expect(r.success).toBe(true);
    const written = setConfig.mock.calls[0][1] as [string, string[]][];
    expect(written).toEqual([["translate", ["translate"]]]);
  });

  it("requires a capability", async () => {
    const r = await handleSetCapabilityMapping({ features: ["x"] }, ACTOR);
    expect(r.success).toBe(false);
    expect(setConfig).not.toHaveBeenCalled();
  });

  it("rejects an empty feature list when not removing", async () => {
    getConfig.mockResolvedValue([]);
    const r = await handleSetCapabilityMapping({ capability: "x", features: [] }, ACTOR);
    expect(r.success).toBe(false);
    expect(setConfig).not.toHaveBeenCalled();
  });

  it("fails to remove a mapping that does not exist", async () => {
    getConfig.mockResolvedValue([["translate", ["translate"]]]);
    const r = await handleSetCapabilityMapping(
      { capability: "none", remove: true },
      ACTOR
    );
    expect(r.success).toBe(false);
    expect(setConfig).not.toHaveBeenCalled();
  });

  it("returns the store error on write failure", async () => {
    getConfig.mockResolvedValue([]);
    setConfig.mockRejectedValue(new Error("write failed"));
    const r = await handleSetCapabilityMapping(
      { capability: "x", features: ["y"] },
      ACTOR
    );
    expect(r.success).toBe(false);
    expect(r.error).toBe("write failed");
  });
});
