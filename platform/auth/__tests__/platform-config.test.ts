/**
 * platform/auth/__tests__/platform-config.test.ts — the pure parts of the config service
 *
 * Value validation and the removed write paths. Everything that reads or writes the database —
 * layered values, per-tenant caching, scopes, history — is proven against Postgres in
 * __tests__/db/platform-config.db.test.ts (ADR-053).
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

import { getConfig, getConfigOrThrow, validateConfigValue } from "../platform-config";
import type { EnhancedConfigEntry } from "@/platform/admin/types";

/** Create a mock EnhancedConfigEntry for validation tests */
function makeEntry(overrides: Partial<EnhancedConfigEntry> = {}): EnhancedConfigEntry {
  return {
    key: "test.key",
    value: "test",
    description: "A test config",
    category: "test",
    updatedAt: "2026-04-22T00:00:00Z",
    defaultValue: "test",
    valueType: "string",
    minValue: null,
    maxValue: null,
    allowedValues: null,
    permissionTier: "standard",
    tenantOverridable: false,
    overridden: false,
    platformValue: "test",
    ...overrides,
  };
}

describe("without a database", () => {
  const saved = process.env.DATABASE_URL;
  beforeAll(() => {
    delete process.env.DATABASE_URL;
  });
  afterAll(() => {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  });

  it("getConfig returns the default — mock and CI runs persist nothing", async () => {
    await expect(getConfig("anything", 7)).resolves.toBe(7);
  });

  it("getConfigOrThrow refuses: a guard must not read a value that is not there", async () => {
    await expect(getConfigOrThrow("anything")).rejects.toThrow(/no database/);
  });
});

describe("removed write paths (audit X-7)", () => {
  it("exports no unvalidated setConfig or deleteConfig", async () => {
    const mod: Record<string, unknown> = await import("../platform-config");
    expect(mod.setConfig).toBeUndefined();
    expect(mod.deleteConfig).toBeUndefined();
    const barrel: Record<string, unknown> = await import("@/platform/auth");
    expect(barrel.setConfig).toBeUndefined();
    expect(barrel.deleteConfig).toBeUndefined();
  });
});

describe("validateConfigValue", () => {
  describe("number type", () => {
    const entry = makeEntry({
      valueType: "number",
      minValue: 1,
      maxValue: 100,
    });

    it("accepts valid number", () => {
      expect(validateConfigValue(entry, 50).valid).toBe(true);
    });

    it("accepts number at min boundary", () => {
      expect(validateConfigValue(entry, 1).valid).toBe(true);
    });

    it("accepts number at max boundary", () => {
      expect(validateConfigValue(entry, 100).valid).toBe(true);
    });

    it("rejects below min", () => {
      const result = validateConfigValue(entry, 0);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("below minimum");
    });

    it("rejects above max", () => {
      const result = validateConfigValue(entry, 101);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("exceeds maximum");
    });

    it("rejects non-numeric value", () => {
      const result = validateConfigValue(entry, "abc");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("must be a number");
    });

    it("coerces numeric string", () => {
      expect(validateConfigValue(entry, "50").valid).toBe(true);
    });

    it("accepts number with no min/max constraints", () => {
      const noConstraints = makeEntry({
        valueType: "number",
        minValue: null,
        maxValue: null,
      });
      expect(validateConfigValue(noConstraints, 999999).valid).toBe(true);
    });
  });

  describe("boolean type", () => {
    const entry = makeEntry({ valueType: "boolean" });

    it("accepts true", () => {
      expect(validateConfigValue(entry, true).valid).toBe(true);
    });

    it("accepts false", () => {
      expect(validateConfigValue(entry, false).valid).toBe(true);
    });

    it("accepts string 'true'", () => {
      expect(validateConfigValue(entry, "true").valid).toBe(true);
    });

    it("accepts string 'false'", () => {
      expect(validateConfigValue(entry, "false").valid).toBe(true);
    });

    it("rejects non-boolean", () => {
      const result = validateConfigValue(entry, "maybe");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("must be a boolean");
    });
  });

  describe("string_enum type", () => {
    const entry = makeEntry({
      valueType: "string_enum",
      allowedValues: ["low", "medium", "high", "critical"],
    });

    it("accepts allowed value", () => {
      expect(validateConfigValue(entry, "medium").valid).toBe(true);
    });

    it("rejects disallowed value", () => {
      const result = validateConfigValue(entry, "extreme");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("not in allowed values");
    });
  });

  describe("json_array type", () => {
    const entry = makeEntry({ valueType: "json_array" });

    it("accepts array", () => {
      expect(validateConfigValue(entry, ["a", "b"]).valid).toBe(true);
    });

    it("accepts valid JSON array string", () => {
      expect(validateConfigValue(entry, '["a","b"]').valid).toBe(true);
    });

    it("rejects non-array", () => {
      const result = validateConfigValue(entry, 42);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("must be a JSON array");
    });

    it("rejects invalid JSON string", () => {
      const result = validateConfigValue(entry, "not json");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("valid JSON array");
    });

    it("rejects JSON object (not array)", () => {
      const result = validateConfigValue(entry, '{"a":1}');
      expect(result.valid).toBe(false);
    });
  });

  describe("value size limit (S3)", () => {
    const entry = makeEntry({ valueType: "string" });

    it("rejects values exceeding 64KB", () => {
      const hugeValue = "x".repeat(70_000);
      const result = validateConfigValue(entry, hugeValue);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("exceeds maximum");
    });

    it("accepts values within size limit", () => {
      const okValue = "x".repeat(1000);
      expect(validateConfigValue(entry, okValue).valid).toBe(true);
    });
  });

  describe("string type", () => {
    const entry = makeEntry({ valueType: "string" });

    it("accepts any string", () => {
      expect(validateConfigValue(entry, "hello").valid).toBe(true);
    });

    it("rejects null", () => {
      const result = validateConfigValue(entry, null);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("must not be null");
    });

    it("rejects undefined", () => {
      const result = validateConfigValue(entry, undefined);
      expect(result.valid).toBe(false);
    });
  });
});

// setConfigWithHistory: platform/auth/__tests__/set-config-with-history.test.ts (in-memory
// database, real audit module).
