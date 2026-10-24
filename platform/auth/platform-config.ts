/**
 * platform/auth/platform-config.ts — Runtime configuration service, layered per tenant
 *
 * Every governed setting has a platform default (platform_config, seeded by migrations) and may
 * have the current tenant's own value (tenant_config_overrides, ADR-053 D5). A read returns the
 * tenant's value when it has one, else the default. Keys marked tenant_overridable may be set by
 * a tenant's administrators; the rest govern the platform (dual control, safety thresholds, cost
 * guards) and are changed by operators — or, in a single-tenant deployment, by its own
 * administrators, whose tenant is the whole platform.
 *
 * Writes are validated against the key's metadata (value_type, min/max, allowed_values),
 * recorded in the audit log first (no record, no change — audit X-8) and in
 * platform_config_history. Reads are cached per instance for 60 seconds, per tenant.
 *
 * Data access is through platform/data (ADR-053 D4): a tenant's reads run in its transaction
 * (row-level security shows it only its own values); platform-default writes run on the owner
 * connection, the one path that may change platform_config.
 *
 * Sprint 7b, Task 7b.1 (original) · Sprint 3a, Phase 4 (validation, history, tiers) ·
 * Sprint 7R/7T (tenancy)
 */

import { audited, AuditWriteError } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";
import {
  hasDatabase,
  withOwnerTx,
  withPlatformTx,
  withTenantTx,
  type Tx,
} from "@/platform/data";
import { peekTenant } from "@/platform/tenancy/context";
import type {
  ConfigValueType,
  ConfigValidationResult,
  EnhancedConfigEntry,
  PermissionTier,
  ConfigHistoryRecord,
  ConfigHistoryOptions,
  ConfigChangeSource,
  ConfigScope,
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

// ── Per-instance cache, per tenant ──────────────────────────────────────

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000; // 60 seconds

/** The cache key: one value per tenant per key (ADR-053 D6). "-" is the no-tenant default. */
function cacheKey(key: string): string {
  return `${peekTenant()?.tenantId ?? "-"}\u0000${key}`;
}

/**
 * What a caller is told when the database refuses or cannot take a change: the database's own
 * message (table, constraint and column names) is logged, never returned — it reaches admins'
 * screens and the config assistant's replies.
 */
const STORAGE_FAILURE =
  "The change could not be saved: the database is unavailable or refused it.";

function getCached(key: string): unknown | undefined {
  const k = cacheKey(key);
  const entry = cache.get(k);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(k);
    return undefined;
  }
  return entry.value;
}

function setCache(key: string, value: unknown): void {
  cache.set(cacheKey(key), { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Forget `key` for every tenant on this instance (a platform default changed). */
function forgetEverywhere(key: string): void {
  for (const k of cache.keys()) if (k.endsWith(`\u0000${key}`)) cache.delete(k);
}

/** Clear all cached config. Call after bulk updates. */
export function clearConfigCache(): void {
  cache.clear();
}

// ── The effective value ─────────────────────────────────────────────────

interface ValueRow {
  value: unknown;
}

/**
 * The effective value of `key`: the current tenant's own, else the platform default; null when
 * the key does not exist. Outside any tenant, the platform default. Throws when unreadable.
 */
async function readEffective(key: string): Promise<ValueRow | null> {
  const sql = (tx: Tx) =>
    tx.query<ValueRow>(
      `select coalesce(o.value, c.value) as value
         from platform_config c
         left join tenant_config_overrides o on o.key = c.key
        where c.key = $1`,
      [key]
    );
  const { rows } = peekTenant()
    ? await withTenantTx(sql)
    : await withPlatformTx((tx) =>
        tx.query<ValueRow>("select value from platform_config where key = $1", [key])
      );
  return rows[0] ?? null;
}

// ── Read Operations ─────────────────────────────────────────────────────

/**
 * Get a single config value by key: the tenant's own value, else the platform default. Returns
 * `defaultValue` when the key is missing, cannot be read, or there is no database.
 * Uses the per-tenant cache (60s TTL).
 */
export async function getConfig<T = unknown>(key: string, defaultValue?: T): Promise<T> {
  const cached = getCached(key);
  if (cached !== undefined) return cached as T;

  let row: ValueRow | null = null;
  if (hasDatabase()) {
    try {
      row = await readEffective(key);
    } catch (err) {
      logger.warn("Config read failed", {
        key,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/auth/platform-config",
      });
    }
  }

  if (!row) {
    if (defaultValue === undefined) {
      logger.warn("Config key not found", {
        key,
        route: "platform/auth/platform-config",
      });
    }
    return defaultValue as T;
  }

  setCache(key, row.value);
  return row.value as T;
}

/**
 * Get a config value, or throw when it is missing or cannot be read. For settings that guard
 * something (dual control, two-person approval): a caller that cannot read one must fail
 * closed, which getConfig's default makes impossible to tell apart from a stored value.
 */
export async function getConfigOrThrow<T = unknown>(key: string): Promise<T> {
  const cached = getCached(key);
  if (cached !== undefined) return cached as T;
  if (!hasDatabase()) {
    throw new Error(`Config key "${key}" unreadable: no database is configured`);
  }
  let row: ValueRow | null;
  try {
    row = await readEffective(key);
  } catch (err) {
    throw new Error(
      `Config key "${key}" unreadable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!row) throw new Error(`Config key "${key}" unreadable: not found`);
  setCache(key, row.value);
  return row.value as T;
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

// ── Entries with metadata ───────────────────────────────────────────────

interface EnhancedConfigRow {
  key: string;
  value: unknown;
  platform_value: unknown;
  overridden: boolean;
  description: string | null;
  category: string;
  updated_at: Date | string;
  default_value: unknown;
  value_type: string;
  min_value: unknown;
  max_value: unknown;
  allowed_values: unknown;
  permission_tier: string;
  tenant_overridable: boolean;
}

/** Every entry with its effective value for the current tenant (or the defaults, outside one). */
async function readEntries(key?: string): Promise<EnhancedConfigRow[]> {
  const params = key === undefined ? [] : [key];
  const tenantSql =
    key === undefined
      ? `select c.key, coalesce(o.value, c.value) as value, c.value as platform_value,
                (o.key is not null) as overridden, c.description, c.category,
                coalesce(o.updated_at, c.updated_at) as updated_at, c.default_value, c.value_type,
                c.min_value, c.max_value, c.allowed_values, c.permission_tier, c.tenant_overridable
           from platform_config c left join tenant_config_overrides o on o.key = c.key
          order by c.category, c.key`
      : `select c.key, coalesce(o.value, c.value) as value, c.value as platform_value,
                (o.key is not null) as overridden, c.description, c.category,
                coalesce(o.updated_at, c.updated_at) as updated_at, c.default_value, c.value_type,
                c.min_value, c.max_value, c.allowed_values, c.permission_tier, c.tenant_overridable
           from platform_config c left join tenant_config_overrides o on o.key = c.key
          where c.key = $1`;
  const platformSql =
    key === undefined
      ? `select c.key, c.value, c.value as platform_value, false as overridden, c.description,
                c.category, c.updated_at, c.default_value, c.value_type, c.min_value, c.max_value,
                c.allowed_values, c.permission_tier, c.tenant_overridable
           from platform_config c order by c.category, c.key`
      : `select c.key, c.value, c.value as platform_value, false as overridden, c.description,
                c.category, c.updated_at, c.default_value, c.value_type, c.min_value, c.max_value,
                c.allowed_values, c.permission_tier, c.tenant_overridable
           from platform_config c where c.key = $1`;
  const { rows } = peekTenant()
    ? await withTenantTx((tx) => tx.query<EnhancedConfigRow>(tenantSql, params))
    : await withPlatformTx((tx) => tx.query<EnhancedConfigRow>(platformSql, params));
  return rows;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
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
    updatedAt: iso(row.updated_at),
    defaultValue: row.default_value,
    valueType: parseValueType(row.value_type),
    minValue: parseNullableNumber(row.min_value),
    maxValue: parseNullableNumber(row.max_value),
    allowedValues: parseAllowedValues(row.allowed_values),
    permissionTier: parsePermissionTier(row.permission_tier),
    tenantOverridable: row.tenant_overridable === true,
    overridden: row.overridden === true,
    platformValue: row.platform_value,
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

/**
 * List all config entries (effective values), optionally filtered by category.
 */
export async function listConfig(category?: string): Promise<ConfigEntry[]> {
  if (!hasDatabase()) return [];
  let rows: EnhancedConfigRow[];
  try {
    rows = await readEntries();
  } catch {
    return [];
  }
  return rows
    .filter((r) => category === undefined || r.category === category)
    .map((row) => ({
      key: row.key,
      value: row.value,
      description: row.description,
      category: row.category,
      updatedAt: iso(row.updated_at),
    }));
}

/**
 * Get a single config entry with full metadata.
 * Returns null if the key does not exist (or cannot be read).
 */
export async function getEnhancedConfig(
  key: string
): Promise<EnhancedConfigEntry | null> {
  if (!hasDatabase()) return null;
  try {
    const rows = await readEntries(key);
    return rows[0] ? mapEnhancedRow(rows[0]) : null;
  } catch (err) {
    logger.warn("Config entry read failed", {
      key,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/platform-config",
    });
    return null;
  }
}

/**
 * List config entries with full metadata. Supports search, category,
 * permission tier, and value type filters.
 */
export async function listEnhancedConfig(
  options?: ConfigSearchOptions
): Promise<EnhancedConfigEntry[]> {
  if (!hasDatabase()) return [];
  let data: EnhancedConfigRow[];
  try {
    data = await readEntries();
  } catch {
    return [];
  }
  // Filters and text search run here, on the (small) list of settings — never by building SQL
  // from input.
  const needle = (options?.query ?? "").trim().toLowerCase();
  return data
    .filter((r) => !options?.category || r.category === options.category)
    .filter(
      (r) => !options?.permissionTier || r.permission_tier === options.permissionTier
    )
    .filter((r) => !options?.valueType || r.value_type === options.valueType)
    .filter(
      (r) =>
        !needle ||
        String(r.key).toLowerCase().includes(needle) ||
        String(r.description ?? "")
          .toLowerCase()
          .includes(needle)
    )
    .map(mapEnhancedRow);
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

interface ConfigHistoryRow {
  id: string;
  config_key: string;
  previous_value: unknown;
  new_value: unknown;
  changed_by: string | null;
  change_comment: string;
  change_source: string;
  created_at: Date | string;
  scope: string;
}

/**
 * Read the current tenant's config change history: changes to its own values, and — in a
 * single-tenant deployment — to the platform defaults its administrators made. Changes an
 * operator made to the shared defaults are not a tenant's to read.
 */
export async function getConfigHistory(
  options?: ConfigHistoryOptions
): Promise<ConfigHistoryRecord[]> {
  if (!hasDatabase()) return [];
  const limit = Math.min(Math.max(Math.floor(options?.limit ?? 50), 1), 500);
  let rows: ConfigHistoryRow[];
  try {
    ({ rows } = await withTenantTx((tx) =>
      tx.query<ConfigHistoryRow>(
        `select id, config_key, previous_value, new_value, changed_by, change_comment,
                change_source, created_at, scope
           from platform_config_history
          where ($1::text is null or config_key = $1)
            and ($2::uuid is null or changed_by = $2)
            and ($3::timestamptz is null or created_at >= $3)
            and ($4::timestamptz is null or created_at <= $4)
          order by created_at desc
          limit $5`,
        [
          options?.configKey ?? null,
          options?.changedBy ?? null,
          options?.since ?? null,
          options?.before ?? null,
          limit,
        ]
      )
    ));
  } catch (err) {
    logger.warn("Config history read failed", {
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/platform-config",
    });
    return [];
  }
  return rows.map((row) => ({
    id: row.id,
    configKey: row.config_key,
    previousValue: row.previous_value,
    newValue: row.new_value,
    changedBy: row.changed_by,
    changeComment: row.change_comment,
    changeSource: row.change_source as ConfigChangeSource,
    createdAt: iso(row.created_at),
    scope: row.scope === "tenant" ? "tenant" : "platform",
  }));
}

// ── Enhanced Write — Validated + History ─────────────────────────────────

/** Where a change goes, and as whom (decided by platform/admin/governed-config.ts). */
export interface ConfigWriteTarget {
  /** The platform default, or the current tenant's own value. */
  readonly scope: ConfigScope;
  /**
   * True when an operator makes the change: an operator may set any key's tenant value, and
   * only an operator may change a shared deployment's platform defaults. A single-tenant
   * deployment's administrators change its defaults with operator: false.
   */
  readonly operator: boolean;
}

/** The default target: the platform default (single-tenant deployments, existing callers). */
export const PLATFORM_DEFAULT_TARGET: ConfigWriteTarget = Object.freeze({
  scope: "platform",
  operator: false,
});

type WriteResult = {
  success: boolean;
  error?: string;
  validationErrors?: readonly string[];
  historyWriteFailed?: boolean;
};

/**
 * Set a config value with full validation, history logging, and audit.
 *
 *   1. Loads the entry metadata to validate against (the caller may pass it)
 *   2. Validates the proposed value (type, range, allowed values) and the target: a tenant's
 *      own value is refused for a key that is not tenant_overridable unless an operator sets it
 *   3. Writes the audit record — and stops, changing nothing, if it cannot (audited)
 *   4. Writes the change and its history record in one transaction: the platform default on the
 *      owner connection, a tenant's value in the tenant's transaction (or, for an operator, on
 *      the owner connection with the tenant named)
 *
 * The caller decides whether the actor may make the change at all (tier permissions, operator
 * status: governed-config.ts). This enforces only what the data model requires.
 */
export async function setConfigWithHistory(
  key: string,
  value: unknown,
  actorId: string,
  changeComment: string,
  changeSource: ConfigChangeSource = "config_agent",
  /** A5: Pass a pre-loaded entry to avoid redundant DB round trip */
  preloadedEntry?: EnhancedConfigEntry,
  target: ConfigWriteTarget = PLATFORM_DEFAULT_TARGET
): Promise<WriteResult> {
  const entry = preloadedEntry ?? (await getEnhancedConfig(key));
  if (!entry) {
    return {
      success: false,
      error: `Config key "${key}" not found. Cannot create new keys via this endpoint.`,
    };
  }

  const validation = validateConfigValue(entry, value);
  if (!validation.valid) {
    return {
      success: false,
      error: "Validation failed",
      validationErrors: validation.errors,
    };
  }

  const tenant = peekTenant();
  if (target.scope === "tenant") {
    if (!tenant) return { success: false, error: "A tenant's value needs a tenant." };
    if (!entry.tenantOverridable && !target.operator) {
      return {
        success: false,
        error: `"${key}" governs the platform; only an operator can set it for a tenant.`,
      };
    }
  }
  if (target.scope === "platform" && tenant?.mode === "shared" && !target.operator) {
    return {
      success: false,
      error: "Only an operator can change a platform default in a shared deployment.",
    };
  }

  const previousValue = target.scope === "platform" ? entry.platformValue : entry.value;
  // History is visible to the tenant whose change it is; a shared deployment's defaults are the
  // operators' alone (tenant_id null).
  const historyTenant =
    target.scope === "tenant" || tenant?.mode !== "shared"
      ? (tenant?.tenantId ?? null)
      : null;

  const write = async (tx: Tx) => {
    if (target.scope === "platform") {
      const r = await tx.query(
        "update platform_config set value = $2::jsonb, updated_by = $3::uuid, updated_at = now() where key = $1",
        [key, JSON.stringify(value), uuidOrNull(actorId)]
      );
      if (r.rowCount !== 1) throw new Error(`Config key "${key}" was not updated`);
    } else {
      await tx.query(
        `insert into tenant_config_overrides (tenant_id, key, value, updated_by)
         values ($1::uuid, $2, $3::jsonb, $4::uuid)
         on conflict (tenant_id, key)
         do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
        [tenant!.tenantId, key, JSON.stringify(value), uuidOrNull(actorId)]
      );
    }
    await tx.query(
      `insert into platform_config_history
         (config_key, previous_value, new_value, changed_by, change_comment, change_source, scope, tenant_id)
       values ($1, $2::jsonb, $3::jsonb, $4::uuid, $5, $6, $7, $8::uuid)`,
      [
        key,
        JSON.stringify(previousValue ?? null),
        JSON.stringify(value ?? null),
        uuidOrNull(actorId),
        changeComment,
        changeSource,
        target.scope,
        historyTenant,
      ]
    );
  };

  try {
    return await audited(
      {
        action: "admin_action",
        actorId,
        details: {
          type: "config_updated_with_history",
          key,
          scope: target.scope,
          previousValue,
          newValue: value,
          changeComment,
          changeSource,
        },
      },
      async (): Promise<WriteResult> => {
        try {
          if (target.scope === "tenant" && !target.operator) await withTenantTx(write);
          else await withOwnerTx("operator", write);
        } catch (err) {
          logger.error("Config update failed", {
            key,
            scope: target.scope,
            error: err instanceof Error ? err.message : String(err),
            route: "platform/auth/platform-config",
          });
          return { success: false, error: STORAGE_FAILURE };
        }
        if (target.scope === "platform") forgetEverywhere(key);
        else cache.delete(cacheKey(key));
        return { success: true, historyWriteFailed: false };
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

/**
 * Remove the current tenant's own value of `key`, so it inherits the platform default again.
 * Audited like a change; the caller decides who may.
 */
export async function clearTenantConfig(
  key: string,
  actorId: string,
  changeComment: string,
  operator: boolean
): Promise<WriteResult> {
  const entry = await getEnhancedConfig(key);
  if (!entry) return { success: false, error: `Config key "${key}" not found.` };
  if (!entry.overridden) return { success: true };
  const tenant = peekTenant();
  if (!tenant) return { success: false, error: "A tenant's value needs a tenant." };
  if (!entry.tenantOverridable && !operator) {
    return {
      success: false,
      error: `"${key}" governs the platform; only an operator can change it for a tenant.`,
    };
  }
  const write = async (tx: Tx) => {
    await tx.query(
      "delete from tenant_config_overrides where tenant_id = $1::uuid and key = $2",
      [tenant.tenantId, key]
    );
    await tx.query(
      `insert into platform_config_history
         (config_key, previous_value, new_value, changed_by, change_comment, change_source, scope, tenant_id)
       values ($1, $2::jsonb, $3::jsonb, $4::uuid, $5, 'admin_ui', 'tenant', $6::uuid)`,
      [
        key,
        JSON.stringify(entry.value ?? null),
        JSON.stringify(entry.platformValue ?? null),
        uuidOrNull(actorId),
        changeComment,
        tenant.tenantId,
      ]
    );
  };
  try {
    return await audited(
      {
        action: "admin_action",
        actorId,
        details: {
          type: "config_override_cleared",
          key,
          previousValue: entry.value,
          changeComment,
        },
      },
      async (): Promise<WriteResult> => {
        try {
          if (operator) await withOwnerTx("operator", write);
          else await withTenantTx(write);
        } catch (err) {
          logger.error("Config reset failed", {
            key,
            error: err instanceof Error ? err.message : String(err),
            route: "platform/auth/platform-config",
          });
          return { success: false, error: STORAGE_FAILURE };
        }
        cache.delete(cacheKey(key));
        return { success: true };
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** updated_by / changed_by reference a user; an actor that is not one (a system job) is null. */
function uuidOrNull(id: string): string | null {
  return UUID.test(id) ? id : null;
}
