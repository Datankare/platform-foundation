/**
 * platform/auth/__tests__/platform-config.test.ts
 *
 * Tests for the runtime configuration service.
 * Covers both original functions (getConfig, setConfig, listConfig,
 * deleteConfig) and Sprint 3a enhancements (getEnhancedConfig,
 * listEnhancedConfig, validateConfigValue, setConfigWithHistory,
 * getConfigHistory, getPermissionTier).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Mocks ───────────────────────────────────────────────────────────────

// Gotcha #2: jest.mock needs generateRequestId
jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

// Chainable Supabase mock builder
function createChainMock(resolvedValue: { data: any; error: any }) {
  const chain: any = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(resolvedValue),
    then: (resolve: any) => resolve(resolvedValue),
  };
  return chain;
}

const mockSupabase = {
  from: jest.fn(),
};

jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: jest.fn(() => mockSupabase),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────

import {
  getConfig,
  getConfigString,
  getConfigNumber,
  getConfigBoolean,
  listConfig,
  setConfig,
  deleteConfig,
  clearConfigCache,
  getEnhancedConfig,
  listEnhancedConfig,
  getPermissionTier,
  validateConfigValue,
  setConfigWithHistory,
  getConfigHistory,
} from "../platform-config";
import type { EnhancedConfigEntry } from "@/platform/admin/types";
import { writeAuditLog } from "@/platform/auth/audit";

// ── Helpers ─────────────────────────────────────────────────────────────

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
    ...overrides,
  };
}

// ── Setup / Teardown ────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  clearConfigCache();
});

// ═══════════════════════════════════════════════════════════════════════
// Original Functions
// ═══════════════════════════════════════════════════════════════════════

describe("getConfig", () => {
  it("returns value from DB on cache miss", async () => {
    const chain = createChainMock({
      data: { value: "hello" },
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getConfig("greeting");
    expect(result).toBe("hello");
    expect(mockSupabase.from).toHaveBeenCalledWith("platform_config");
  });

  it("returns cached value on cache hit", async () => {
    const chain = createChainMock({
      data: { value: 42 },
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    await getConfig("num");
    mockSupabase.from.mockClear();

    const result = await getConfig("num");
    expect(result).toBe(42);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it("returns defaultValue when key not found", async () => {
    const chain = createChainMock({ data: null, error: null });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getConfig("missing", "fallback");
    expect(result).toBe("fallback");
  });

  it("returns defaultValue on DB error", async () => {
    const chain = createChainMock({
      data: null,
      error: { message: "connection refused" },
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getConfig("broken", "safe");
    expect(result).toBe("safe");
  });
});

describe("getConfigString", () => {
  it("returns string value", async () => {
    const chain = createChainMock({ data: { value: "en" }, error: null });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getConfigString("lang", "en");
    expect(result).toBe("en");
  });

  it("coerces non-string to string", async () => {
    const chain = createChainMock({ data: { value: 123 }, error: null });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getConfigString("num_as_str");
    expect(result).toBe("123");
  });
});

describe("getConfigNumber", () => {
  it("returns number value", async () => {
    const chain = createChainMock({ data: { value: 100 }, error: null });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getConfigNumber("rate_limit");
    expect(result).toBe(100);
  });

  it("coerces string to number", async () => {
    const chain = createChainMock({ data: { value: "50" }, error: null });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getConfigNumber("str_num");
    expect(result).toBe(50);
  });
});

describe("getConfigBoolean", () => {
  it("returns boolean value", async () => {
    const chain = createChainMock({ data: { value: true }, error: null });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getConfigBoolean("flag");
    expect(result).toBe(true);
  });

  it("parses string 'true'", async () => {
    const chain = createChainMock({ data: { value: "true" }, error: null });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getConfigBoolean("str_bool");
    expect(result).toBe(true);
  });

  it("parses string 'false'", async () => {
    const chain = createChainMock({ data: { value: "false" }, error: null });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getConfigBoolean("str_bool_f");
    expect(result).toBe(false);
  });
});

describe("listConfig", () => {
  it("returns mapped entries", async () => {
    const chain = createChainMock({
      data: [
        {
          key: "k1",
          value: "v1",
          description: "desc",
          category: "cat",
          updated_at: "2026-04-22T00:00:00Z",
        },
      ],
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await listConfig();
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("k1");
    expect(result[0].updatedAt).toBe("2026-04-22T00:00:00Z");
  });

  it("filters by category", async () => {
    const chain = createChainMock({ data: [], error: null });
    mockSupabase.from.mockReturnValue(chain);

    await listConfig("moderation");
    expect(chain.eq).toHaveBeenCalledWith("category", "moderation");
  });

  it("returns empty array on error", async () => {
    const chain = createChainMock({
      data: null,
      error: { message: "DB error" },
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await listConfig();
    expect(result).toEqual([]);
  });
});

describe("setConfig", () => {
  it("upserts value and clears cache", async () => {
    const chain = createChainMock({ data: null, error: null });
    mockSupabase.from.mockReturnValue(chain);

    const result = await setConfig("k1", "v1", "user-1");
    expect(result.success).toBe(true);
    expect(chain.upsert).toHaveBeenCalled();
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin_action",
        actorId: "user-1",
      })
    );
  });

  it("returns error on DB failure", async () => {
    const chain = createChainMock({
      data: null,
      error: { message: "write failed" },
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await setConfig("k1", "v1", "user-1");
    expect(result.success).toBe(false);
    expect(result.error).toBe("write failed");
  });
});

describe("deleteConfig", () => {
  it("deletes key and writes audit", async () => {
    const chain = createChainMock({ data: null, error: null });
    // delete().eq() chain needs special handling
    chain.delete = jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await deleteConfig("k1", "user-1");
    expect(result.success).toBe(true);
    expect(writeAuditLog).toHaveBeenCalled();
  });
});

describe("clearConfigCache", () => {
  it("clears the cache so next read hits DB", async () => {
    // Prime cache
    const chain1 = createChainMock({ data: { value: "cached" }, error: null });
    mockSupabase.from.mockReturnValue(chain1);
    await getConfig("cached_key");

    // Clear cache
    clearConfigCache();

    // Next read should hit DB
    const chain2 = createChainMock({
      data: { value: "fresh" },
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain2);
    const result = await getConfig("cached_key");
    expect(result).toBe("fresh");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Sprint 3a — Enhanced Operations
// ═══════════════════════════════════════════════════════════════════════

describe("getEnhancedConfig", () => {
  it("returns full entry with metadata", async () => {
    const chain = createChainMock({
      data: {
        key: "rate_limit_rpm",
        value: 100,
        description: "Rate limit",
        category: "system",
        updated_at: "2026-04-22T00:00:00Z",
        default_value: 100,
        value_type: "number",
        min_value: 10,
        max_value: 1000,
        allowed_values: null,
        permission_tier: "standard",
      },
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getEnhancedConfig("rate_limit_rpm");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("rate_limit_rpm");
    expect(result!.valueType).toBe("number");
    expect(result!.minValue).toBe(10);
    expect(result!.maxValue).toBe(1000);
    expect(result!.permissionTier).toBe("standard");
  });

  it("returns null when key not found", async () => {
    const chain = createChainMock({ data: null, error: { message: "not found" } });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getEnhancedConfig("nonexistent");
    expect(result).toBeNull();
  });

  it("parses string min/max values to numbers (Gotcha #6)", async () => {
    const chain = createChainMock({
      data: {
        key: "k",
        value: 0.5,
        description: null,
        category: "mod",
        updated_at: "2026-04-22T00:00:00Z",
        default_value: 0.5,
        value_type: "number",
        min_value: "0.0",
        max_value: "1.0",
        allowed_values: null,
        permission_tier: "safety",
      },
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getEnhancedConfig("k");
    expect(result!.minValue).toBe(0);
    expect(result!.maxValue).toBe(1);
  });

  it("parses string allowed_values to array (Gotcha #7)", async () => {
    const chain = createChainMock({
      data: {
        key: "k",
        value: "low",
        description: null,
        category: "mod",
        updated_at: "2026-04-22T00:00:00Z",
        default_value: "low",
        value_type: "string_enum",
        min_value: null,
        max_value: null,
        allowed_values: '["low","medium","high","critical"]',
        permission_tier: "safety",
      },
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getEnhancedConfig("k");
    expect(result!.allowedValues).toEqual(["low", "medium", "high", "critical"]);
  });

  it("falls back to 'string' for unknown value_type", async () => {
    const chain = createChainMock({
      data: {
        key: "k",
        value: "x",
        description: null,
        category: "test",
        updated_at: "2026-04-22T00:00:00Z",
        default_value: "x",
        value_type: "unknown_type",
        min_value: null,
        max_value: null,
        allowed_values: null,
        permission_tier: "standard",
      },
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getEnhancedConfig("k");
    expect(result!.valueType).toBe("string");
  });
});

describe("listEnhancedConfig", () => {
  it("returns all entries when no filters", async () => {
    const chain = createChainMock({
      data: [
        {
          key: "k1",
          value: "v1",
          description: "d1",
          category: "c1",
          updated_at: "2026-04-22T00:00:00Z",
          default_value: "v1",
          value_type: "string",
          min_value: null,
          max_value: null,
          allowed_values: null,
          permission_tier: "standard",
        },
      ],
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await listEnhancedConfig();
    expect(result).toHaveLength(1);
  });

  it("applies search query filter", async () => {
    const chain = createChainMock({ data: [], error: null });
    mockSupabase.from.mockReturnValue(chain);

    await listEnhancedConfig({ query: "moderation" });
    expect(chain.or).toHaveBeenCalledWith(expect.stringContaining("moderation"));
  });

  it("applies permission tier filter", async () => {
    const chain = createChainMock({ data: [], error: null });
    mockSupabase.from.mockReturnValue(chain);

    await listEnhancedConfig({ permissionTier: "safety" });
    expect(chain.eq).toHaveBeenCalledWith("permission_tier", "safety");
  });
});

describe("getPermissionTier", () => {
  it("returns tier from DB", async () => {
    const chain = createChainMock({
      data: {
        key: "rate_limit_rpm",
        value: 100,
        description: null,
        category: "system",
        updated_at: "2026-04-22T00:00:00Z",
        default_value: 100,
        value_type: "number",
        min_value: null,
        max_value: null,
        allowed_values: null,
        permission_tier: "standard",
      },
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getPermissionTier("rate_limit_rpm");
    expect(result).toBe("standard");
  });

  it("returns 'safety' as fail-closed default for unknown keys", async () => {
    const chain = createChainMock({ data: null, error: { message: "not found" } });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getPermissionTier("nonexistent");
    expect(result).toBe("safety");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Validation (pure function — no mocks needed)
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// setConfigWithHistory
// ═══════════════════════════════════════════════════════════════════════

describe("setConfigWithHistory", () => {
  it("validates, writes config, writes history, writes audit", async () => {
    // First call: getEnhancedConfig (select...single)
    const enhancedChain = createChainMock({
      data: {
        key: "rate_limit_rpm",
        value: 100,
        description: "Rate limit",
        category: "system",
        updated_at: "2026-04-22T00:00:00Z",
        default_value: 100,
        value_type: "number",
        min_value: 10,
        max_value: 1000,
        allowed_values: null,
        permission_tier: "standard",
      },
      error: null,
    });

    // Second call: update
    const updateChain = createChainMock({ data: null, error: null });

    // Third call: history insert
    const historyChain = createChainMock({ data: null, error: null });

    let callCount = 0;
    mockSupabase.from.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return enhancedChain;
      if (callCount === 2) return updateChain;
      return historyChain;
    });

    const result = await setConfigWithHistory(
      "rate_limit_rpm",
      200,
      "admin-1",
      "Increasing rate limit for load test"
    );

    expect(result.success).toBe(true);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin_action",
        actorId: "admin-1",
        details: expect.objectContaining({
          type: "config_updated_with_history",
          key: "rate_limit_rpm",
          previousValue: 100,
          newValue: 200,
        }),
      })
    );
  });

  it("rejects when key not found", async () => {
    const chain = createChainMock({ data: null, error: { message: "not found" } });
    mockSupabase.from.mockReturnValue(chain);

    const result = await setConfigWithHistory("nonexistent", "val", "admin-1", "comment");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns validation errors for invalid value", async () => {
    const chain = createChainMock({
      data: {
        key: "rate_limit_rpm",
        value: 100,
        description: null,
        category: "system",
        updated_at: "2026-04-22T00:00:00Z",
        default_value: 100,
        value_type: "number",
        min_value: 10,
        max_value: 1000,
        allowed_values: null,
        permission_tier: "standard",
      },
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await setConfigWithHistory(
      "rate_limit_rpm",
      9999,
      "admin-1",
      "Too high"
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Validation failed");
    expect(result.validationErrors).toBeDefined();
    expect(result.validationErrors![0]).toContain("exceeds maximum");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getConfigHistory
// ═══════════════════════════════════════════════════════════════════════

describe("getConfigHistory", () => {
  it("returns mapped history records", async () => {
    const chain = createChainMock({
      data: [
        {
          id: "hist-1",
          config_key: "rate_limit_rpm",
          previous_value: 100,
          new_value: 200,
          changed_by: "admin-1",
          change_comment: "Increasing for load test",
          change_source: "config_agent",
          created_at: "2026-04-22T12:00:00Z",
        },
      ],
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getConfigHistory({ configKey: "rate_limit_rpm" });
    expect(result).toHaveLength(1);
    expect(result[0].configKey).toBe("rate_limit_rpm");
    expect(result[0].previousValue).toBe(100);
    expect(result[0].newValue).toBe(200);
    expect(result[0].changeSource).toBe("config_agent");
  });

  it("applies date range filters", async () => {
    const chain = createChainMock({ data: [], error: null });
    mockSupabase.from.mockReturnValue(chain);

    await getConfigHistory({
      since: "2026-04-01T00:00:00Z",
      before: "2026-04-30T00:00:00Z",
    });

    expect(chain.gte).toHaveBeenCalledWith("created_at", "2026-04-01T00:00:00Z");
    expect(chain.lte).toHaveBeenCalledWith("created_at", "2026-04-30T00:00:00Z");
  });

  it("applies limit (default 50)", async () => {
    const chain = createChainMock({ data: [], error: null });
    mockSupabase.from.mockReturnValue(chain);

    await getConfigHistory();
    expect(chain.limit).toHaveBeenCalledWith(50);
  });

  it("returns empty array on error", async () => {
    const chain = createChainMock({
      data: null,
      error: { message: "DB error" },
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getConfigHistory();
    expect(result).toEqual([]);
  });
});
