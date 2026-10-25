/**
 * __tests__/r13-reset-killswitch.test.ts — Review 13 M1 (a held reset, at the handler) and L2 (the
 * reviewer's kill-switch re-run proof, inverted)
 *
 *   M1  a held reset applies only while the platform default it would inherit is the one recorded
 *       when it was requested (`heldPrevious.inherited`); a changed default, or a hold that
 *       recorded none, is stale — nothing is cleared. The write is compare-and-set on both.
 *   L2  every agent already suspended (the first run's publish failed): the re-run writes nothing
 *       and publishes the registry's invalidation stamp again, so other instances drop the stale
 *       cache — the runbook's recovery for config.invalidation_unpublished now does something.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const suspended = [["agent:a", { owner: "o", scopes: ["x"], status: "suspended" }]];
let entry: Record<string, unknown> = {};
const setConfigWithHistory = jest.fn();
const clearTenantConfig = jest.fn(async () => ({ success: true }));
jest.mock("@/platform/auth/platform-config", () => ({
  ...jest.requireActual("@/platform/auth/platform-config"),
  getEnhancedConfig: async () => entry,
  getConfigOrThrow: async (key: string) => {
    if (key === "config.require_two_person_approval") return false;
    throw new Error(`unexpected ${key}`);
  },
  setConfigWithHistory: (...a: unknown[]) => setConfigWithHistory(...a),
  clearTenantConfig: (...a: unknown[]) => clearTenantConfig(...(a as [])),
}));
const cacheSet = jest.fn(async () => undefined);
jest.mock("@/platform/cache", () => ({
  getCache: () => ({ set: cacheSet, get: async () => null }),
}));

import { suspendAllAgents } from "@/platform/admin/agent-kill-switch";
import { handleResetConfig } from "@/platform/admin/config-handlers";
import { runWithTenant } from "@/platform/tenancy/context";

const SHARED = Object.freeze({
  tenantId: "00000000-0000-4000-8000-0000000000e2",
  mode: "shared" as const,
});

beforeEach(() => {
  setConfigWithHistory.mockReset();
  clearTenantConfig.mockClear();
  cacheSet.mockClear();
});

describe("R13-L2 the kill switch re-run publishes the invalidation again", () => {
  it("every agent already suspended: no write, a new stamp published", async () => {
    entry = {
      key: "agent.trusted_agents",
      value: suspended,
      platformValue: suspended,
      overridden: false,
      tenantOverridable: false,
    };
    const out = await suspendAllAgents(
      {
        userId: "00000000-0000-4000-8000-0000000000aa",
        sub: "s",
        roleName: "admin",
        permissions: [],
      } as never,
      "re-run after config.invalidation_unpublished"
    );
    expect(out).toEqual({ ok: true, suspended: [], republished: true });
    expect(setConfigWithHistory).not.toHaveBeenCalled();
    // Re-published: other instances drop their cached registry at their next read.
    expect(cacheSet).toHaveBeenCalledTimes(1);
    expect(cacheSet.mock.calls[0]).toEqual([
      "config:invalidated:agent.trusted_agents",
      expect.any(String),
      { ttlSeconds: 600 },
    ]);
  });

  it("the shared cache still down: says it was not re-published", async () => {
    cacheSet.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const out = await suspendAllAgents(
      { userId: "u", sub: "s", roleName: "admin", permissions: [] } as never,
      "again"
    );
    expect(out).toEqual({ ok: true, suspended: [], republished: false });
  });
});

describe("R13-M1 a held reset applies only onto the default it was requested to inherit", () => {
  const KEY = "moderation.level1.block_severity";
  const reset = (heldPrevious: Record<string, unknown>) =>
    runWithTenant(SHARED, () =>
      handleResetConfig({
        key: KEY,
        changeComment: "back to the default",
        actorId: "00000000-0000-4000-8000-0000000000bb",
        actorIsOperator: true,
        confirmed: true,
        heldPrevious: heldPrevious as never,
      })
    );
  beforeEach(() => {
    entry = {
      key: KEY,
      value: 0,
      platformValue: 99, // the default moved since the reset was requested (it was 1)
      overridden: true,
      tenantOverridable: true,
      permissionTier: "standard",
    };
  });

  it("the default changed since the request: stale, nothing cleared", async () => {
    const r = await reset({ value: 0, overridden: true, inherited: 1 });
    expect(r.data).toMatchObject({ applied: false, stale: true });
    expect(clearTenantConfig).not.toHaveBeenCalled();
  });

  it("a held reset that recorded no inherited value: stale (fail closed)", async () => {
    const r = await reset({ value: 0, overridden: true });
    expect(r.data).toMatchObject({ applied: false, stale: true });
    expect(clearTenantConfig).not.toHaveBeenCalled();
  });

  it("the default unchanged: cleared, compare-and-set on the tenant's value and the default", async () => {
    entry = { ...entry, platformValue: 1 };
    const r = await reset({ value: 0, overridden: true, inherited: 1 });
    expect(r.data).toMatchObject({ applied: true });
    expect(clearTenantConfig).toHaveBeenCalledWith(
      KEY,
      "00000000-0000-4000-8000-0000000000bb",
      "back to the default",
      true,
      { expectPrevious: { value: 0 }, expectInherited: { value: 1 } }
    );
  });
});
