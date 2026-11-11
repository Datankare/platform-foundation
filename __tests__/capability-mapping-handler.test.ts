/**
 * __tests__/capability-mapping-handler.test.ts — U3 capability-mapping handler (Sprint 3c).
 */

import { handleSetCapabilityMapping } from "@/app/api/admin/ai/handlers/mapping";

const getConfig = jest.fn();
const writeGovernedConfig = jest.fn();
// The map is read fail closed (review 13 P): getConfigOrThrow, never getConfig's default.
jest.mock("@/platform/auth/platform-config", () => ({
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
const written = (n = 0): unknown => writeGovernedConfig.mock.calls[n][1].value;

beforeEach(() => {
  getConfig.mockReset();
  writeGovernedConfig.mockReset();
  writeGovernedConfig.mockResolvedValue({ kind: "applied", result: {} });
});

describe("handleSetCapabilityMapping", () => {
  it("adds a new capability mapping", async () => {
    getConfig.mockResolvedValue([["translate", ["translate"]]]);
    const r = await handleSetCapabilityMapping(
      { capability: "summarize", features: ["translate", "speak"] },
      ACTOR
    );
    expect(r.success).toBe(true);
    expect(written()).toContainEqual(["summarize", ["translate", "speak"]]);
    expect(writeGovernedConfig).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        changeComment: "",
        changeShown: expect.objectContaining({
          key: "screens.admin_console.results.command_bar_comment",
        }),
      })
    );
  });

  it("replaces an existing capability's feature list", async () => {
    getConfig.mockResolvedValue([["translate", ["translate"]]]);
    await handleSetCapabilityMapping(
      { capability: "translate", features: ["translate", "tts"] },
      ACTOR
    );
    expect(written()).toEqual([["translate", ["translate", "tts"]]]);
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
    expect(written()).toEqual([["translate", ["translate"]]]);
  });

  it("requires a capability", async () => {
    const r = await handleSetCapabilityMapping({ features: ["x"] }, ACTOR);
    expect(r.success).toBe(false);
    expect(writeGovernedConfig).not.toHaveBeenCalled();
  });

  it("rejects an empty feature list when not removing", async () => {
    getConfig.mockResolvedValue([]);
    const r = await handleSetCapabilityMapping({ capability: "x", features: [] }, ACTOR);
    expect(r.success).toBe(false);
    expect(writeGovernedConfig).not.toHaveBeenCalled();
  });

  it("fails to remove a mapping that does not exist", async () => {
    getConfig.mockResolvedValue([["translate", ["translate"]]]);
    const r = await handleSetCapabilityMapping(
      { capability: "none", remove: true },
      ACTOR
    );
    expect(r.success).toBe(false);
    expect(writeGovernedConfig).not.toHaveBeenCalled();
  });

  it("an unreadable map changes nothing — never read as empty, which would erase every mapping (review 13 P)", async () => {
    getConfig.mockRejectedValue(new Error("config store down"));
    const r = await handleSetCapabilityMapping(
      { capability: "summarize", features: ["x"] },
      ACTOR
    );
    // Coded (rebase round 2, finding 2): the map could not be read, nothing was changed.
    expect(r).toEqual({
      success: false,
      error: "service.unavailable",
      code: "service.unavailable",
      params: { service: "capabilities" },
    });
    expect(writeGovernedConfig).not.toHaveBeenCalled();
  });

  it.each([
    ["not a list", { translate: ["translate"] }],
    ["an entry not a pair", [["translate"]]],
    ["features not strings", [["translate", [1]]]],
  ])("a malformed map (%s) changes nothing", async (_name, map) => {
    getConfig.mockResolvedValue(map);
    const r = await handleSetCapabilityMapping(
      { capability: "x", features: ["y"] },
      ACTOR
    );
    expect(r.success).toBe(false);
    expect(writeGovernedConfig).not.toHaveBeenCalled();
  });

  it("reports a write failure coded, the store's text logged, never returned", async () => {
    getConfig.mockResolvedValue([]);
    writeGovernedConfig.mockResolvedValue({
      kind: "failed",
      result: {
        toolId: "update_config",
        success: false,
        data: null,
        error: "write failed",
        durationMs: 0,
      },
    });
    const r = await handleSetCapabilityMapping(
      { capability: "x", features: ["y"] },
      ACTOR
    );
    expect(r).toMatchObject({
      success: false,
      error: "admin.action_failed",
      code: "admin.action_failed",
    });
  });
});
