/**
 * platform/admin/__tests__/governed-config.test.ts — the one admin config write path (audit X-7)
 *
 * The tier permission is checked before anything is dispatched, an unknown key is refused,
 * and the outcome of the governed tool (applied, held, two-person pending, invalid, failed)
 * is reported as what it is — a held or pending change is never reported as applied.
 */

jest.mock("@/platform/admin/config-handlers", () => ({
  dispatchConfigTool: jest.fn(),
  codedConfigFailure: jest.requireActual("@/platform/admin/config-handlers")
    .codedConfigFailure,
}));
jest.mock("@/platform/auth/platform-config", () => ({ getEnhancedConfig: jest.fn() }));

import { dispatchConfigTool } from "@/platform/admin/config-handlers";
import { getEnhancedConfig } from "@/platform/auth/platform-config";
import {
  describeFailure,
  resetGovernedConfig,
  tierPermission,
  writeGovernedConfig,
} from "@/platform/admin/governed-config";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";

const dispatch = dispatchConfigTool as jest.Mock;
const entry = getEnhancedConfig as jest.Mock;

const standardAdmin: VerifiedAdmin = {
  userId: "00000000-0000-4000-8000-00000000a001",
  sub: "s1",
  roleName: "admin",
  permissions: ["config_view", "config_manage_standard"],
};
const safetyAdmin: VerifiedAdmin = {
  ...standardAdmin,
  roleName: "super_admin",
  permissions: ["config_view", "config_manage_standard", "config_manage_safety"],
};
const change = { key: "k", value: 5, changeComment: "c" };
const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({
  toolId: "update_config",
  success: true,
  data,
  durationMs: 1,
  ...extra,
});

beforeEach(() => jest.resetAllMocks());

describe("tierPermission", () => {
  it("maps standard to config_manage_standard and anything else to safety", () => {
    expect(tierPermission("standard")).toBe("config_manage_standard");
    expect(tierPermission("safety")).toBe("config_manage_safety");
    expect(tierPermission("")).toBe("config_manage_safety");
    expect(tierPermission("STANDARD")).toBe("config_manage_safety");
  });
});

describe("writeGovernedConfig", () => {
  it("refuses an unknown key without dispatching", async () => {
    entry.mockResolvedValue(null);
    await expect(writeGovernedConfig(safetyAdmin, change)).resolves.toEqual({
      kind: "not_found",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses a safety-tier key to an admin without config_manage_safety", async () => {
    entry.mockResolvedValue({ key: "k", permissionTier: "safety" });
    await expect(writeGovernedConfig(standardAdmin, change)).resolves.toEqual({
      kind: "refused",
      permission: "config_manage_safety",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses a standard key to an admin with no config write permission", async () => {
    entry.mockResolvedValue({ key: "k", permissionTier: "standard" });
    const viewer = { ...standardAdmin, permissions: ["config_view"] };
    await expect(writeGovernedConfig(viewer, change)).resolves.toMatchObject({
      kind: "refused",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches the governed update as the verified admin, confirmed", async () => {
    entry.mockResolvedValue({ key: "k", permissionTier: "standard" });
    dispatch.mockResolvedValue(ok({ applied: true }));
    const outcome = await writeGovernedConfig(standardAdmin, change);
    expect(outcome.kind).toBe("applied");
    expect(dispatch).toHaveBeenCalledWith(
      "update_config",
      {
        key: "k",
        value: 5,
        changeComment: "c",
        actorId: standardAdmin.userId,
        actorIsOperator: false,
        confirmed: true,
      },
      undefined
    );
  });

  it("reports a dual-control hold as pending", async () => {
    entry.mockResolvedValue({ key: "k", permissionTier: "safety" });
    dispatch.mockResolvedValue({ ...ok(null), success: false, held: true });
    await expect(writeGovernedConfig(safetyAdmin, change)).resolves.toMatchObject({
      kind: "pending",
    });
  });

  it("reports a two-person approval request as pending", async () => {
    entry.mockResolvedValue({ key: "k", permissionTier: "safety" });
    dispatch.mockResolvedValue(ok({ applied: false, requiresApproval: true }));
    await expect(writeGovernedConfig(safetyAdmin, change)).resolves.toMatchObject({
      kind: "pending",
    });
  });

  // Round 13, P-1: a filing refused — another change to the key already waiting — is no
  // pending approval; it was reported pending, and the change shown as held for approval.
  it("reports a refused two-person filing as failed, never pending", async () => {
    entry.mockResolvedValue({ key: "k", permissionTier: "safety" });
    dispatch.mockResolvedValue(
      ok({
        applied: false,
        requiresApproval: true,
        approvalError: 'A pending approval already exists for "k".',
      })
    );
    await expect(writeGovernedConfig(safetyAdmin, change)).resolves.toMatchObject({
      kind: "failed",
    });
  });

  it("reports validation errors as invalid", async () => {
    entry.mockResolvedValue({ key: "k", permissionTier: "standard" });
    dispatch.mockResolvedValue(ok({ applied: false, validationErrors: ["too big"] }));
    await expect(writeGovernedConfig(standardAdmin, change)).resolves.toEqual({
      kind: "invalid",
      errors: ["too big"],
      // Uncoded (an older result): the key, and the reason the message words as "other".
      params: { key: "k", reason: "other" },
    });
  });

  it.each([
    ["a write that did not apply", ok({ applied: false })],
    ["a runtime failure", { ...ok(null), success: false, error: "boom" }],
    ["an empty result", ok(undefined)],
  ])("reports %s as failed, never applied", async (_label, result) => {
    entry.mockResolvedValue({ key: "k", permissionTier: "standard" });
    dispatch.mockResolvedValue(result);
    await expect(writeGovernedConfig(standardAdmin, change)).resolves.toMatchObject({
      kind: "failed",
    });
  });
});

describe("resetGovernedConfig (round 13, P-1)", () => {
  it("reports a refused two-person filing as failed, never pending", async () => {
    entry.mockResolvedValue({
      key: "k",
      permissionTier: "safety",
      tenantOverridable: true,
    });
    dispatch.mockResolvedValue(
      ok({ applied: false, requiresApproval: true, approvalError: "already waiting" })
    );
    await expect(
      resetGovernedConfig(safetyAdmin, { key: "k", changeComment: "c" })
    ).resolves.toMatchObject({ kind: "failed" });
  });

  it("reports a filed two-person approval as pending", async () => {
    entry.mockResolvedValue({
      key: "k",
      permissionTier: "safety",
      tenantOverridable: true,
    });
    dispatch.mockResolvedValue(ok({ applied: false, requiresApproval: true }));
    await expect(
      resetGovernedConfig(safetyAdmin, { key: "k", changeComment: "c" })
    ).resolves.toMatchObject({ kind: "pending" });
  });
});

describe("describeFailure", () => {
  it("prefers the tool error, then the data error, then validation errors", () => {
    expect(describeFailure({ ...ok(null), error: "e1" })).toBe("e1");
    expect(describeFailure(ok({ error: "e2" }))).toBe("e2");
    expect(describeFailure(ok({ validationErrors: ["a", "b"] }))).toBe("a; b");
    expect(describeFailure(ok(null))).toBe("Config change failed");
  });
});
