/**
 * platform/auth/platform-config.ts — Runtime configuration service
 *
 * Read/write platform_config table. All mutations are audit-logged.
 * Includes an in-memory cache (60s TTL) to avoid DB round-trips
 * on every request for frequently-read config like feature flags.
 *
 * Enhanced in Sprint 3a (Phase 4) with:
 *   - Validation against value_type, min/max, allowed_values (Migration 011)
 *   - Permission tier checks (standard vs safety)
 *   - Change history logging to platform_config_history
 *   - Enhanced config reads with full metadata
 *
 * Sprint 7b, Task 7b.1 (original)
 * Sprint 3a, Phase 4 (enhanced)
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { audited, AuditWriteError } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";
import type {
  ConfigValueType,
  ConfigValidationResult,
  EnhancedConfigEntry,
  PermissionTier,
  ConfigHistoryRecord,
  ConfigHistoryOptions,
  ConfigChangeSource,
  ConfigSearchOptions,
} from "@/platform/admin/types";

// ── Re-export original ConfigEntry for backward compatibility ───────

export interface ConfigEntry {
  key: string;
  value: unknown;
  description: string | null;
  category: string;
  updatedAt: string;
}

// ── In-Memory Cache ─────────────────────────────────────────────────────

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000; // 60 seconds

function getCached(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCache(key: string, value: unknown): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Clear all cached config. Call after bulk updates. */
export function clearConfigCache(): void {
  cache.clear();
}

// ── Read Operations ─────────────────────────────────────────────────────

/**
 * Get a single config value by key. Returns the parsed JSON value.
 * Uses in-memory cache (60s TTL).
 */
export async function getConfig<T = unknown>(key: string, defaultValue?: T): Promise<T> {
  const cached = getCached(key);
  if (cached !== undefined) return cached as T;

  const supabase = getSupabaseServiceClient();
  const { data, error } = await (supabase
    .from("platform_config" as never)
    .select("value")
    .eq("key", key)
    .single() as unknown as Promise<{
    data: { value: unknown } | null;
    error: { message: string } | null;
  }>);

  if (error || !data) {
    if (defaultValue !== undefined) return defaultValue;
    logger.warn("Config key not found", {
      key,
      route: "platform/auth/platform-config",
    });
    return defaultValue as T;
  }

  const value = data.value as T;
  setCache(key, value);
  return value;
}

/**
 * Get a config value, or throw when it is missing or cannot be read. For settings that guard
 * something (dual control, two-person approval): a caller that cannot read one must fail
 * closed, which getConfig's default makes impossible to tell apart from a stored value.
 */
export async function getConfigOrThrow<T = unknown>(key: string): Promise<T> {
  const cached = getCached(key);
  if (cached !== undefined) return cached as T;
  const supabase = getSupabaseServiceClient();
  const { data, error } = await (supabase
    .from("platform_config" as never)
    .select("value")
    .eq("key", key)
    .single() as unknown as Promise<{
    data: { value: unknown } | null;
    error: { message: string } | null;
  }>);
  if (error || !data) {
    throw new Error(`Config key "${key}" unreadable: ${error?.message ?? "not found"}`);
  }
  setCache(key, data.value);
  return data.value as T;
}

/**
 * Get a config value as a typed primitive (string, number, boolean).
 * Convenience wrapper around getConfig that handles JSON parsing.
 */
export async function getConfigString(
  key: string,
  defaultValue: string = ""
): Promise<string> {
  const val = await getConfig<string>(key, defaultValue);
  return typeof val === "string" ? val : String(val);
}

export async function getConfigNumber(
  key: string,
  defaultValue: number = 0
): Promise<number> {
  const val = await getConfig<number>(key, defaultValue);
  return typeof val === "number" ? val : Number(val);
}

export async function getConfigBoolean(
  key: string,
  defaultValue: boolean = false
): Promise<boolean> {
  const val = await getConfig(key, defaultValue);
  if (typeof val === "boolean") return val;
  if (typeof val === "string") return val === "true";
  return Boolean(val);
}

/**
 * List all config entries, optionally filtered by category.
 */
export async function listConfig(category?: string): Promise<ConfigEntry[]> {
  const supabase = getSupabaseServiceClient();

  const baseQuery = supabase
    .from("platform_config" as never)
    .select("key, value, description, category, updated_at")
    .order("category")
    .order("key");

  const query = category ? baseQuery.eq("category", category) : baseQuery;

  const { data, error } = (await query) as {
    data: Array<{
      key: string;
      value: unknown;
      description: string | null;
      category: string;
      updated_at: string;
    }> | null;
    error: { message: string } | null;
  };

  if (error || !data) return [];

  return data.map(
    (row: {
      key: string;
      value: unknown;
      description: string | null;
      category: string;
      updated_at: string;
    }) => ({
      key: row.key,
      value: row.value,
      description: row.description,
      category: row.category,
      updatedAt: row.updated_at,
    })
  );
}

// ── Write Operations ────────────────────────────────────────────────────
//
// Admin changes go through platform/admin/governed-config.ts (writeGovernedConfig), which
// checks the key's tier permission and then calls setConfigWithHistory below via the governed
// config tool. The unvalidated setConfig and deleteConfig were removed in Sprint 7X (audit X-7);
// config keys are created and removed only by migrations.

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 3a Enhancements — Validation, History, Permission Tiers
// ═══════════════════════════════════════════════════════════════════════════

// ── Enhanced Read Operations ────────────────────────────────────────────

/**
 * DB row shape for the enhanced platform_config query.
 * Matches Migration 011 column names exactly.
 */
interface EnhancedConfigRow {
  key: string;
  value: unknown;
  description: string | null;
  category: string;
  updated_at: string;
  default_value: unknown;
  value_type: string;
  min_value: unknown;
  max_value: unknown;
  allowed_values: unknown;
  permission_tier: string;
}

/**
 * Map a DB row to an EnhancedConfigEntry.
 *
 * Gotcha #6: min_value/max_value are JSONB — parse to number.
 * Gotcha #7: allowed_values is JSONB — parse to string array.
 */
function mapEnhancedRow(row: EnhancedConfigRow): EnhancedConfigEntry {
  return {
    key: row.key,
    value: row.value,
    description: row.description,
    category: row.category,
    updatedAt: row.updated_at,
    defaultValue: row.default_value,
    valueType: parseValueType(row.value_type),
    minValue: parseNullableNumber(row.min_value),
    maxValue: parseNullableNumber(row.max_value),
    allowedValues: parseAllowedValues(row.allowed_values),
    permissionTier: parsePermissionTier(row.permission_tier),
  };
}

/** Parse a value_type string to the ConfigValueType union. Falls back to "string". */
function parseValueType(raw: string): ConfigValueType {
  const valid: ReadonlySet<string> = new Set([
    "string",
    "number",
    "boolean",
    "string_enum",
    "json_array",
  ]);
  return valid.has(raw) ? (raw as ConfigValueType) : "string";
}

/** Parse a JSONB number field. Returns null if not a valid number. */
function parseNullableNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Parse a JSONB allowed_values field to a string array. */
function parseAllowedValues(raw: unknown): readonly string[] | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Parse a permission_tier string. Falls back to "standard". */
function parsePermissionTier(raw: string): PermissionTier {
  return raw === "safety" ? "safety" : "standard";
}

/** The full column list for enhanced config queries */
const ENHANCED_CONFIG_COLUMNS =
  "key, value, description, category, updated_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier";

/**
 * Get a single config entry with full metadata.
 * Returns null if the key does not exist.
 */
export async function getEnhancedConfig(
  key: string
): Promise<EnhancedConfigEntry | null> {
  const supabase = getSupabaseServiceClient();

  const { data, error } = await (supabase
    .from("platform_config" as never)
    .select(ENHANCED_CONFIG_COLUMNS)
    .eq("key", key)
    .single() as unknown as Promise<{
    data: EnhancedConfigRow | null;
    error: { message: string } | null;
  }>);

  if (error || !data) return null;

  return mapEnhancedRow(data);
}

/**
 * List config entries with full metadata. Supports search, category,
 * permission tier, and value type filters.
 */
export async function listEnhancedConfig(
  options?: ConfigSearchOptions
): Promise<EnhancedConfigEntry[]> {
  const supabase = getSupabaseServiceClient();

  let query = supabase
    .from("platform_config" as never)
    .select(ENHANCED_CONFIG_COLUMNS)
    .order("category")
    .order("key");

  if (options?.category) {
    query = query.eq("category", options.category);
  }
  if (options?.permissionTier) {
    query = query.eq("permission_tier", options.permissionTier);
  }
  if (options?.valueType) {
    query = query.eq("value_type", options.valueType);
  }
  const { data, error } = (await query) as {
    data: EnhancedConfigRow[] | null;
    error: { message: string } | null;
  };

  if (error || !data) return [];

  // Text search is done here, on the (small) list of settings — never by building a filter
  // string from input (release review, Sprint 7X; it was a sanitized .or() before).
  const needle = (options?.query ?? "").trim().toLowerCase();
  const rows = needle
    ? data.filter(
        (r) =>
          String(r.key).toLowerCase().includes(needle) ||
          String(r.description ?? "")
            .toLowerCase()
            .includes(needle)
      )
    : data;
  return rows.map(mapEnhancedRow);
}

/**
 * Get the permission tier for a config key.
 * Returns "safety" as fail-closed default if key is not found.
 */
export async function getPermissionTier(key: string): Promise<PermissionTier> {
  const entry = await getEnhancedConfig(key);
  // Fail-closed: treat unknown keys as safety-tier (P11)
  return entry?.permissionTier ?? "safety";
}

// ── Validation ──────────────────────────────────────────────────────────

/**
 * Validate a proposed config value against the entry's metadata.
 *
 * Checks:
 *   1. Value type matches (number, boolean, string, string_enum, json_array)
 *   2. Number values within min/max bounds
 *   3. String enum values in allowed_values list
 *   4. JSON array values are valid arrays
 */
/** Maximum serialized size for a config value (64 KB). Prevents unbounded storage. */
const MAX_CONFIG_VALUE_BYTES = 65_536;

export function validateConfigValue(
  entry: EnhancedConfigEntry,
  proposedValue: unknown
): ConfigValidationResult {
  const errors: string[] = [];

  // S3: Enforce max size to prevent unbounded storage
  try {
    const serialized = JSON.stringify(proposedValue);
    if (serialized.length > MAX_CONFIG_VALUE_BYTES) {
      errors.push(
        `Value size ${serialized.length} bytes exceeds maximum ${MAX_CONFIG_VALUE_BYTES} bytes`
      );
      return { valid: false, errors };
    }
  } catch {
    errors.push("Value cannot be serialized to JSON");
    return { valid: false, errors };
  }

  switch (entry.valueType) {
    case "number": {
      const num =
        typeof proposedValue === "number" ? proposedValue : Number(proposedValue);
      if (!Number.isFinite(num)) {
        errors.push(`Value must be a number, got: ${typeof proposedValue}`);
        break;
      }
      if (entry.minValue !== null && num < entry.minValue) {
        errors.push(`Value ${num} is below minimum ${entry.minValue}`);
      }
      if (entry.maxValue !== null && num > entry.maxValue) {
        errors.push(`Value ${num} exceeds maximum ${entry.maxValue}`);
      }
      break;
    }
    case "boolean": {
      if (
        typeof proposedValue !== "boolean" &&
        proposedValue !== "true" &&
        proposedValue !== "false"
      ) {
        errors.push(
          `Value must be a boolean (true/false), got: ${String(proposedValue)}`
        );
      }
      break;
    }
    case "string_enum": {
      const strVal = String(proposedValue);
      if (entry.allowedValues !== null && !entry.allowedValues.includes(strVal)) {
        errors.push(
          `Value "${strVal}" is not in allowed values: ${entry.allowedValues.join(", ")}`
        );
      }
      break;
    }
    case "json_array": {
      if (!Array.isArray(proposedValue)) {
        // Try parsing if string
        if (typeof proposedValue === "string") {
          try {
            const parsed = JSON.parse(proposedValue);
            if (!Array.isArray(parsed)) {
              errors.push("Value must be a JSON array");
            }
          } catch {
            errors.push("Value must be a valid JSON array");
          }
        } else {
          errors.push("Value must be a JSON array");
        }
      }
      break;
    }
    case "string": {
      // String type — no special validation beyond existence
      if (proposedValue === null || proposedValue === undefined) {
        errors.push("Value must not be null or undefined");
      }
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── History Operations ──────────────────────────────────────────────────

/**
 * DB row shape for platform_config_history.
 */
interface ConfigHistoryRow {
  id: string;
  config_key: string;
  previous_value: unknown;
  new_value: unknown;
  changed_by: string | null;
  change_comment: string;
  change_source: string;
  created_at: string;
}

/**
 * Write a history record to platform_config_history.
 *
 * Unlike moderation audit (fire-and-forget per P11), config history IS
 * the audit trail — callers must know if it fails so gaps are surfaceable.
 * Failures are caught (never throw) but returned to the caller.
 *
 * Error logs include the full change payload so gaps are reconstructible
 * from Sentry even if the DB write is permanently lost.
 */
async function writeConfigHistory(
  configKey: string,
  previousValue: unknown,
  newValue: unknown,
  changedBy: string,
  changeComment: string,
  changeSource: ConfigChangeSource = "admin_ui"
): Promise<{ success: boolean; error?: string }> {
  const changePayload = {
    configKey,
    previousValue,
    newValue,
    changedBy,
    changeComment,
    changeSource,
    route: "platform/auth/platform-config",
  };

  try {
    const supabase = getSupabaseServiceClient();
    const { error } = await (supabase.from("platform_config_history" as never).insert({
      config_key: configKey,
      // jsonb columns take the value itself (a stringified value is stored as a JSON string).
      previous_value: previousValue !== undefined ? previousValue : null,
      new_value: newValue ?? null,
      changed_by: changedBy,
      change_comment: changeComment,
      change_source: changeSource,
    } as never) as unknown as Promise<{
      error: { message: string } | null;
    }>);

    if (error) {
      logger.error("Config history write failed — full payload for reconstruction", {
        ...changePayload,
        error: error.message,
      });
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err) {
    logger.error("Config history write error — full payload for reconstruction", {
      ...changePayload,
      error: err instanceof Error ? err.message : String(err),
    });
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read config change history from platform_config_history.
 */
export async function getConfigHistory(
  options?: ConfigHistoryOptions
): Promise<ConfigHistoryRecord[]> {
  const supabase = getSupabaseServiceClient();

  let query = supabase
    .from("platform_config_history" as never)
    .select(
      "id, config_key, previous_value, new_value, changed_by, change_comment, change_source, created_at"
    )
    .order("created_at", { ascending: false });

  if (options?.configKey) {
    query = query.eq("config_key", options.configKey);
  }
  if (options?.changedBy) {
    query = query.eq("changed_by", options.changedBy);
  }
  if (options?.since) {
    query = query.gte("created_at", options.since);
  }
  if (options?.before) {
    query = query.lte("created_at", options.before);
  }

  const limit = options?.limit ?? 50;
  query = query.limit(limit);

  const { data, error } = (await query) as {
    data: ConfigHistoryRow[] | null;
    error: { message: string } | null;
  };

  if (error || !data) return [];

  return data.map((row: ConfigHistoryRow) => ({
    id: row.id,
    configKey: row.config_key,
    previousValue: row.previous_value,
    newValue: row.new_value,
    changedBy: row.changed_by,
    changeComment: row.change_comment,
    changeSource: row.change_source as ConfigChangeSource,
    createdAt: row.created_at,
  }));
}

// ── Enhanced Write — Validated + History ─────────────────────────────────

/**
 * Set a config value with full validation, history logging, and audit.
 *
 * This function:
 *   1. Loads the entry metadata to validate against
 *   2. Validates the proposed value (type, range, allowed values)
 *   3. Writes the audit record — and stops, changing nothing, if it cannot (audited)
 *   4. Writes the change to platform_config
 *   5. Writes a history record to platform_config_history
 *
 * Returns validation errors if the value is invalid.
 * Returns a permission error if the key doesn't exist (fail-closed).
 */
export async function setConfigWithHistory(
  key: string,
  value: unknown,
  actorId: string,
  changeComment: string,
  changeSource: ConfigChangeSource = "config_agent",
  /** A5: Pass a pre-loaded entry to avoid redundant DB round trip */
  preloadedEntry?: EnhancedConfigEntry
): Promise<{
  success: boolean;
  error?: string;
  validationErrors?: readonly string[];
  historyWriteFailed?: boolean;
}> {
  // 1. Load entry metadata (A5: skip if pre-loaded by caller)
  const entry = preloadedEntry ?? (await getEnhancedConfig(key));
  if (!entry) {
    return {
      success: false,
      error: `Config key "${key}" not found. Cannot create new keys via this endpoint.`,
    };
  }

  // 2. Validate proposed value
  const validation = validateConfigValue(entry, value);
  if (!validation.valid) {
    return {
      success: false,
      error: "Validation failed",
      validationErrors: validation.errors,
    };
  }

  // 3. Capture previous value for history
  const previousValue = entry.value;

  // 4–6. Record the change, then make it (audited): with no audit record the value is not
  //      changed (audit X-8 — this record was fire-and-forget). Then cache and history.
  const supabase = getSupabaseServiceClient();
  try {
    return await audited(
      {
        action: "admin_action",
        actorId,
        details: {
          type: "config_updated_with_history",
          key,
          previousValue,
          newValue: value,
          changeComment,
          changeSource,
        },
      },
      async () => {
        const { error } = await (supabase
          .from("platform_config" as never)
          .update({
            // The value itself: jsonb stores a JSON.stringify'd value as a string, so a governed
            // list or number read back as text and every check built on it failed (release
            // review, Sprint 7X; migration 045 repairs values written that way).
            value,
            updated_by: actorId,
            updated_at: new Date().toISOString(),
          } as never)
          .eq("key", key) as unknown as Promise<{
          error: { message: string } | null;
        }>);

        if (error) {
          logger.error("Config update failed", {
            key,
            error: error.message,
            route: "platform/auth/platform-config",
          });
          return { success: false, error: error.message };
        }

        cache.delete(key);

        const historyResult = await writeConfigHistory(
          key,
          previousValue,
          value,
          actorId,
          changeComment,
          changeSource
        );
        return { success: true, historyWriteFailed: !historyResult.success };
      }
    );
  } catch (err) {
    if (err instanceof AuditWriteError) {
      return {
        success: false,
        error: "The audit log is unavailable, so the value was not changed.",
      };
    }
    throw err;
  }
}
