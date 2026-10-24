/**
 * platform/auth/__tests__/platform-config-failures.test.ts — what configuration does when the
 * database cannot answer (platform/auth/platform-config.ts)
 *
 * With platform/data mocked so a read or write fails on demand: reads fall back to their defaults
 * (or throw, for getConfigOrThrow) and never cache a failure; writes report failure; an audit log
 * that cannot be written stops the change. The SQL itself is proven in __tests__/db.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/** Each query takes the next answer: rows, or an Error to throw. */
let answers: (Record<string, unknown>[] | Error)[] = [];
const run = (fn: (tx: unknown) => unknown) =>
  fn({
    tenantId: "00000000-0000-4000-8000-000000000001",
    query: async () => {
      const next = answers.shift() ?? [];
      if (next instanceof Error) throw next;
      return { rows: next, rowCount: next.length };
    },
  });
jest.mock("@/platform/data", () => ({
  withTenantTx: run,
  withPlatformTx: run,
  withOwnerTx: (_purpose: string, fn: (tx: unknown) => unknown) => run(fn),
  hasDatabase: () => true,
}));

let auditFails = false;
jest.mock("@/platform/auth/audit", () => {
  class AuditWriteError extends Error {}
  return {
    AuditWriteError,
    audited: async (_entry: unknown, act: () => Promise<unknown>) => {
      if (auditFails) throw new AuditWriteError("audit down");
      return act();
    },
  };
});

import {
  clearConfigCache,
  clearTenantConfig,
  getConfig,
  getConfigBoolean,
  getConfigHistory,
  getConfigOrThrow,
  getEnhancedConfig,
  listConfig,
  listEnhancedConfig,
} from "@/platform/auth/platform-config";
import { runWithTenant } from "@/platform/tenancy/context";

const TENANT = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  mode: "shared" as const,
});
const down = () => new Error("connection refused");

/** An entry row as readEntries returns it. */
const entryRow = (over: Record<string, unknown> = {}) => ({
  key: "max_devices_per_player",
  value: 5,
  platform_value: 3,
  overridden: true,
  description: "d",
  category: "devices",
  updated_at: new Date("2026-01-01T00:00:00Z"),
  default_value: 3,
  value_type: "number",
  min_value: 1,
  max_value: 10,
  allowed_values: null,
  permission_tier: "standard",
  tenant_overridable: true,
  ...over,
});

beforeEach(() => {
  answers = [];
  auditFails = false;
  clearConfigCache();
});

describe("reads that cannot be answered", () => {
  it("getConfig falls back to the default, and does not cache the failure", async () => {
    answers = [down(), [{ value: 9 }]];
    await expect(getConfig("k", 1)).resolves.toBe(1);
    await expect(getConfig("k", 1)).resolves.toBe(9);
  });

  it("getConfig caches a value until its time runs out", async () => {
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    answers = [[{ value: 2 }], [{ value: 3 }]];
    await expect(getConfig("ttl")).resolves.toBe(2);
    await expect(getConfig("ttl")).resolves.toBe(2); // cached
    now.mockReturnValue(1_000_000 + 61_000);
    await expect(getConfig("ttl")).resolves.toBe(3); // expired, read again
    now.mockRestore();
  });

  it("getConfigOrThrow throws — naming the key — when unreadable or missing", async () => {
    answers = [down()];
    await expect(getConfigOrThrow("k")).rejects.toThrow(
      'Config key "k" unreadable: connection refused'
    );
    answers = [[]];
    await expect(getConfigOrThrow("k")).rejects.toThrow(
      'Config key "k" unreadable: not found'
    );
  });

  it("getConfigBoolean reads true/false strings and other values by truthiness", async () => {
    answers = [[{ value: "true" }]];
    await expect(getConfigBoolean("b1")).resolves.toBe(true);
    answers = [[{ value: "no" }]];
    await expect(getConfigBoolean("b2")).resolves.toBe(false);
    answers = [[{ value: 1 }]];
    await expect(getConfigBoolean("b3")).resolves.toBe(true);
    answers = [[{ value: 0 }]];
    await expect(getConfigBoolean("b4")).resolves.toBe(false);
  });

  it("listing and lookups answer empty, never a partial or invented entry", async () => {
    answers = [down()];
    await expect(listConfig()).resolves.toEqual([]);
    answers = [down()];
    await expect(listEnhancedConfig()).resolves.toEqual([]);
    answers = [down()];
    await expect(getEnhancedConfig("k")).resolves.toBeNull();
    answers = [down()];
    await expect(getConfigHistory()).resolves.toEqual([]);
  });

  it("parses allowed values given as JSON text, and ignores what is not a list", async () => {
    answers = [[entryRow({ allowed_values: '["a","b"]' })]];
    expect((await getEnhancedConfig("k"))?.allowedValues).toEqual(["a", "b"]);
    answers = [[entryRow({ allowed_values: "{not json" })]];
    expect((await getEnhancedConfig("k"))?.allowedValues).toBeNull();
    answers = [[entryRow({ allowed_values: '{"a":1}' })]];
    expect((await getEnhancedConfig("k"))?.allowedValues).toBeNull();
    answers = [[entryRow({ allowed_values: 7 })]];
    expect((await getEnhancedConfig("k"))?.allowedValues).toBeNull();
  });
});

describe("clearing a tenant's value", () => {
  const clear = (operator = false) =>
    runWithTenant(TENANT, () =>
      clearTenantConfig("max_devices_per_player", "admin-1", "c", operator)
    );

  it("reports the write's failure without the database's own message", async () => {
    answers = [[entryRow()], down()];
    await expect(clear()).resolves.toEqual({
      success: false,
      error: "The change could not be saved: the database is unavailable or refused it.",
    });
  });

  it("changes nothing when its audit record cannot be written", async () => {
    auditFails = true;
    answers = [[entryRow()]];
    await expect(clear()).resolves.toEqual({
      success: false,
      error: "The audit log is unavailable, so the value was not changed.",
    });
  });

  it("an operator's clear goes through the owner connection and succeeds", async () => {
    answers = [[entryRow({ tenant_overridable: false })], [], []];
    await expect(clear(true)).resolves.toEqual({ success: true });
  });

  it("a value that is not the tenant's own needs no change", async () => {
    answers = [[entryRow({ overridden: false })]];
    await expect(clear()).resolves.toEqual({ success: true });
  });

  it("refuses an administrator a key that governs the platform", async () => {
    answers = [[entryRow({ tenant_overridable: false })]];
    await expect(clear()).resolves.toMatchObject({ success: false });
  });

  it("refuses outside a tenant, and an unknown key", async () => {
    answers = [[entryRow()]];
    await expect(
      clearTenantConfig("max_devices_per_player", "admin-1", "c", false)
    ).resolves.toMatchObject({ success: false });
    answers = [[]];
    await expect(clear()).resolves.toMatchObject({ success: false });
  });
});
