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
 * Across instances (review 12 L7): the keys whose change must reach every instance at once — the
 * agent registry and the capability map (POWER_REDUCIBLE_KEYS: a kill switch, a suspension) — are
 * served from the cache only while their shared invalidation stamp is the one they were read
 * under. Every write of such a key publishes a new stamp through the shared cache (the one
 * CACHE_PROVIDER selects), as the permissions cache does (audit RR-9): every instance re-reads
 * the key at its next read, not up to 60 seconds later. A stamp that cannot be read is not
 * trusted (the key is read from the database); a stamp read waits at most 200 ms and is not
 * attempted while the shared cache keeps failing (a circuit breaker, review 13 M2 —
 * platform/cache/stamp-reader.ts); a stamp that cannot be published is logged and alerted
 * (config.invalidation_unpublished) — then the 60-second TTL is the bound.
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
import { randomUUID } from "node:crypto";
import { getCache } from "@/platform/cache";
import { readStamp } from "@/platform/cache/stamp-reader";
import { raiseAlert } from "@/platform/observability/alert";
import { POWER_REDUCIBLE_KEYS } from "@/platform/admin/power-reduction";
import {
  hasDatabase,
  inTransaction,
  onCommit,
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
  /** A shared-stamped key's invalidation stamp when it was read (review 12 L7). */
  stamp?: string;
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
/** A write whose commit was lost with its connection (review 14 L-2): it may have landed. */
const COMMIT_UNKNOWN =
  "The database connection was lost while the change was being saved: it may or may not have been applied. Read the setting again before you retry.";

/** Whether a write's error says its commit's outcome is unknown (platform/data, by shape). */
function commitOutcomeUnknown(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { indeterminate?: unknown }).indeterminate === true
  );
}

/** Whether a change of `key` is published to every instance (review 12 L7). */
export function isSharedInvalidationKey(key: string): boolean {
  return POWER_REDUCIBLE_KEYS.has(key);
}

const stampKey = (key: string) => `config:invalidated:${key}`;
/** How long a stamp is kept: longer than any cache entry lives. */
const STAMP_TTL_SECONDS = 600;

/**
 * The shared invalidation stamp of `key` ("-" when none was published), or undefined when it
 * cannot be read — then nothing cached for it is trusted and the key is read from the database.
 * Bounded (review 13 M2): at most STAMP_READ_TIMEOUT_MS, and not attempted at all while the
 * stamp breaker is open (platform/cache/stamp-reader.ts) — a hanging shared cache never holds a
 * read of a stamped key.
 */
async function currentStamp(key: string): Promise<string | undefined> {
  const read = await readStamp(
    async () => (await getCache().get<string>(stampKey(key))) ?? "-"
  );
  return read.ok ? read.value : undefined;
}

/**
 * Tell every instance that `key` changed (review 12 L7): a new stamp in the shared cache, so each
 * drops its cached value at its next read. Logged and alerted when it cannot be published (the
 * 60-second TTL is then the bound). Returns whether it was published. This instance forgets the
 * key itself in the write.
 */
export async function publishConfigInvalidation(key: string): Promise<boolean> {
  if (!isSharedInvalidationKey(key)) return true;
  // Inside a caller's transaction the change is not visible until it commits: published now,
  // another instance would re-read the OLD value and cache it under the new stamp. So it is
  // published after the commit — and never if the transaction rolls back (review 13 L5). When
  // the commit's outcome is unknown (its connection was lost) it is published all the same
  // (review 14 L-2): the change may have landed, and a needless invalidation costs a re-read.
  if (typeof inTransaction === "function" && inTransaction()) {
    if (
      typeof onCommit === "function" &&
      onCommit(() => publishNow(key).then(() => {}), { idempotent: true })
    ) {
      return true;
    }
  }
  return publishNow(key);
}

async function publishNow(key: string): Promise<boolean> {
  try {
    await getCache().set(stampKey(key), randomUUID(), { ttlSeconds: STAMP_TTL_SECONDS });
    return true;
  } catch (err) {
    logger.error("Config invalidation not published to other instances", {
      key,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/platform-config",
    });
    raiseAlert({
      name: "config.invalidation_unpublished",
      message: `A change of ${key} could not be published to other instances; they may serve the old value for up to ${CACHE_TTL_MS / 1000} s.`,
      tags: { key },
    });
    return false;
  }
}

/**
 * The cached value of `key`, or undefined. For a shared-stamped key, also the stamp read now
 * (`stamp`): the caller caches what it reads under it.
 */
async function getCached(
  key: string
): Promise<{ value: unknown | undefined; stamp?: string; trusted: boolean }> {
  const shared = isSharedInvalidationKey(key);
  const stamp = shared ? await currentStamp(key) : undefined;
  const k = cacheKey(key);
  const entry = cache.get(k);
  // A stamp that cannot be read: nothing cached is trusted, and nothing read is cached.
  if (shared && stamp === undefined) return { value: undefined, trusted: false };
  if (!entry) return { value: undefined, stamp, trusted: true };
  if (Date.now() > entry.expiresAt || (shared && entry.stamp !== stamp)) {
    cache.delete(k);
    return { value: undefined, stamp, trusted: true };
  }
  return { value: entry.value, stamp, trusted: true };
}

function setCache(key: string, value: unknown, stamp?: string): void {
  cache.set(cacheKey(key), {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
    ...(stamp !== undefined ? { stamp } : {}),
  });
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
  const cached = await getCached(key);
  if (cached.value !== undefined) return cached.value as T;

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

  if (cached.trusted) setCache(key, row.value, cached.stamp);
  return row.value as T;
}

/**
 * Get a config value, or throw when it is missing or cannot be read. For settings that guard
 * something (dual control, two-person approval): a caller that cannot read one must fail
 * closed, which getConfig's default makes impossible to tell apart from a stored value.
 */
export async function getConfigOrThrow<T = unknown>(key: string): Promise<T> {
  const cached = await getCached(key);
  if (cached.value !== undefined) return cached.value as T;
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
  if (cached.trusted) setCache(key, row.value, cached.stamp);
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

/**
 * A setting retired by a migration (category 'retired', review 7 L2): kept with its history as
 * the record of what it was, never listed and never set.
 */
export const RETIRED_CATEGORY = "retired";

/**
 * Every entry with its effective value for the current tenant (or the defaults, outside one).
 * The list leaves out retired settings; one read by its key is returned (so a write can say why
 * it is refused).
 */
async function readEntries(key?: string): Promise<EnhancedConfigRow[]> {
  const params = key === undefined ? [] : [key];
  const tenantSql =
    key === undefined
      ? `select c.key, coalesce(o.value, c.value) as value, c.value as platform_value,
                (o.key is not null) as overridden, c.description, c.category,
                coalesce(o.updated_at, c.updated_at) as updated_at, c.default_value, c.value_type,
                c.min_value, c.max_value, c.allowed_values, c.permission_tier, c.tenant_overridable
           from platform_config c left join tenant_config_overrides o on o.key = c.key
          where c.category <> 'retired'
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
           from platform_config c where c.category <> 'retired' order by c.category, c.key`
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

  // TASK-147: every case decides on the value's own type — no String() or Number() of an
  // arbitrary value (an object without a prototype made String() throw: an uncoded 500), and
  // the value a form sends as text ("50", "true", "[...]") is stored as the type it names
  // (`value`), never as the text (null, "", true and [] passed a number setting as 0 or 1).
  let value: unknown = proposedValue;
  switch (entry.valueType) {
    case "number": {
      const num =
        typeof proposedValue === "number"
          ? proposedValue
          : typeof proposedValue === "string" &&
              /^-?\d+(?:\.\d+)?$/.test(proposedValue.trim())
            ? Number(proposedValue.trim())
            : NaN;
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
      value = num;
      break;
    }
    case "boolean": {
      if (typeof proposedValue === "boolean") break;
      if (proposedValue === "true" || proposedValue === "false") {
        value = proposedValue === "true";
        break;
      }
      errors.push(`Value must be a boolean (true/false), got: ${typeof proposedValue}`);
      break;
    }
    case "string_enum": {
      if (typeof proposedValue !== "string") {
        errors.push(`Value must be text, got: ${typeof proposedValue}`);
        break;
      }
      if (entry.allowedValues !== null && !entry.allowedValues.includes(proposedValue)) {
        errors.push(
          `Value "${proposedValue}" is not in allowed values: ${entry.allowedValues.join(", ")}`
        );
      }
      break;
    }
    case "json_array": {
      if (Array.isArray(proposedValue)) break;
      if (typeof proposedValue === "string") {
        try {
          const parsed: unknown = JSON.parse(proposedValue);
          if (Array.isArray(parsed)) value = parsed;
          else errors.push("Value must be a JSON array");
        } catch {
          errors.push("Value must be a valid JSON array");
        }
      } else {
        errors.push("Value must be a JSON array");
      }
      break;
    }
    case "string": {
      if (typeof proposedValue !== "string") {
        errors.push(
          `Value must be text, got: ${proposedValue === null ? "null" : typeof proposedValue}`
        );
      }
      break;
    }
  }

  return errors.length === 0 ? { valid: true, errors, value } : { valid: false, errors };
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
  /**
   * A compare-and-set found the value it replaces changed since it was read (review 11 M-2,
   * review 12 H2): nothing was changed.
   */
  stale?: boolean;
  /**
   * The write's commit was lost with its connection (review 14 L-2): it may or may not have been
   * applied. Not a success — and not a failure: the audit records `indeterminate`, and the
   * invalidation was published all the same.
   */
  indeterminate?: boolean;
};

/**
 * Serialise writes of `key` for the transaction (review 11 M-2, review 12 L5). A platform-default
 * write takes the key's platform lock; a tenant's write takes the platform lock FIRST and then its
 * own — its compare-and-set may compare against the platform default it inherits, so a concurrent
 * default change must not land between its check and its write. One order everywhere (platform,
 * then tenant): two writers cannot wait on each other. Transaction-scoped advisory locks: open to
 * every role, released at commit.
 */
async function lockConfigKey(
  tx: Tx,
  key: string,
  scope: ConfigScope,
  tenantId: string | undefined
): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `platform_config:platform:${key}`,
  ]);
  if (scope === "tenant") {
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `platform_config:${tenantId}:${key}`,
    ]);
  }
}

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
/** The value a compare-and-set write expected was changed by another write first. */
class ConfigChangedError extends Error {
  constructor(key: string) {
    super(
      `"${key}" changed since it was read, so nothing was changed. Read it again and retry.`
    );
    this.name = "ConfigChangedError";
  }
}

export async function setConfigWithHistory(
  key: string,
  value: unknown,
  actorId: string,
  changeComment: string,
  changeSource: ConfigChangeSource = "config_agent",
  /** A5: Pass a pre-loaded entry to avoid redundant DB round trip */
  preloadedEntry?: EnhancedConfigEntry,
  target: ConfigWriteTarget = PLATFORM_DEFAULT_TARGET,
  options: {
    /**
     * Compare-and-set (review 11 M-2): write only if the value being replaced — the target's, read
     * in the writing transaction — still equals this one; otherwise nothing is changed and the
     * result says the value changed. A change judged against the value it replaces (a power
     * reduction) cannot then undo a concurrent change.
     */
    readonly expectPrevious?: { readonly value: unknown };
  } = {}
): Promise<WriteResult> {
  const entry = preloadedEntry ?? (await getEnhancedConfig(key));
  if (!entry) {
    return {
      success: false,
      error: `Config key "${key}" not found. Cannot create new keys via this endpoint.`,
    };
  }

  if (entry.category === RETIRED_CATEGORY) {
    return {
      success: false,
      error: `Config key "${key}" is retired: nothing reads it, and it cannot be set.`,
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
  // Stored as the type the setting names ("50" from a form is stored as 50).
  value = validation.value;

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
    // Writes of one key are serialised for the transaction (review 11 M-2, review 12 L5): a
    // compare-and-set below then reads what is committed, and no write — of this scope or of the
    // platform default a tenant's value inherits — lands between its check and its write.
    await lockConfigKey(tx, key, target.scope, tenant?.tenantId);
    if (options.expectPrevious) {
      // The value this write replaces: the tenant's own, else the platform default it inherits.
      // jsonb equality is by value, not by text.
      const expected = JSON.stringify(options.expectPrevious.value ?? null);
      const own =
        target.scope === "tenant"
          ? await tx.query<{ same: boolean }>(
              "select value = $3::jsonb as same from tenant_config_overrides where tenant_id = $1::uuid and key = $2",
              [tenant!.tenantId, key, expected]
            )
          : { rows: [] as { same: boolean }[] };
      const same = own.rows.length
        ? own.rows[0].same
        : (
            await tx.query<{ same: boolean }>(
              "select value = $2::jsonb as same from platform_config where key = $1",
              [key, expected]
            )
          ).rows[0]?.same === true;
      if (!same) throw new ConfigChangedError(key);
    }
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
          if (err instanceof ConfigChangedError) {
            return { success: false, error: err.message, stale: true };
          }
          if (commitOutcomeUnknown(err)) {
            // It may have landed: every instance forgets the key, as after a write (review 14 L-2).
            logger.error(
              "Config update's commit was lost: whether it was applied is unknown",
              {
                key,
                scope: target.scope,
                route: "platform/auth/platform-config",
              }
            );
            if (target.scope === "platform") forgetEverywhere(key);
            else cache.delete(cacheKey(key));
            await publishConfigInvalidation(key);
            return { success: false, error: COMMIT_UNKNOWN, indeterminate: true };
          }
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
        await publishConfigInvalidation(key);
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
  operator: boolean,
  options: {
    /**
     * Compare-and-set (review 12 H2): remove the tenant's value only if it is still this one (an
     * approved reset, against the value recorded when it was requested); otherwise nothing is
     * changed and the result is stale.
     */
    readonly expectPrevious?: { readonly value: unknown };
    /**
     * Compare-and-set of what the reset resets TO (review 13 M1): remove the tenant's value only
     * if the platform default it will inherit is still this one — the value the approver was
     * shown when the reset was requested. A default changed since makes the reset stale: the
     * tenant would otherwise be left with a value no approver saw.
     */
    readonly expectInherited?: { readonly value: unknown };
  } = {}
): Promise<WriteResult> {
  const entry = await getEnhancedConfig(key);
  if (!entry) return { success: false, error: `Config key "${key}" not found.` };
  if (!entry.overridden) {
    return options.expectPrevious
      ? { success: false, error: new ConfigChangedError(key).message, stale: true }
      : { success: true };
  }
  const tenant = peekTenant();
  if (!tenant) return { success: false, error: "A tenant's value needs a tenant." };
  if (!entry.tenantOverridable && !operator) {
    return {
      success: false,
      error: `"${key}" governs the platform; only an operator can change it for a tenant.`,
    };
  }
  const write = async (tx: Tx) => {
    // The same locks, in the same order, as a write of the key (review 12 L5).
    await lockConfigKey(tx, key, "tenant", tenant.tenantId);
    if (options.expectPrevious) {
      const { rows } = await tx.query<{ same: boolean }>(
        "select value = $3::jsonb as same from tenant_config_overrides where tenant_id = $1::uuid and key = $2",
        [tenant.tenantId, key, JSON.stringify(options.expectPrevious.value ?? null)]
      );
      if (rows[0]?.same !== true) throw new ConfigChangedError(key);
    }
    if (options.expectInherited) {
      // Under the key's platform lock (taken first, above): no default change lands between this
      // check and the delete.
      const { rows } = await tx.query<{ same: boolean }>(
        "select value = $2::jsonb as same from platform_config where key = $1",
        [key, JSON.stringify(options.expectInherited.value ?? null)]
      );
      if (rows[0]?.same !== true) throw new ConfigChangedError(key);
    }
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
          if (err instanceof ConfigChangedError) {
            return { success: false, error: err.message, stale: true };
          }
          if (commitOutcomeUnknown(err)) {
            // It may have landed: every instance forgets the key, as after a reset (review 14 L-2).
            logger.error(
              "Config reset's commit was lost: whether it was applied is unknown",
              {
                key,
                route: "platform/auth/platform-config",
              }
            );
            cache.delete(cacheKey(key));
            await publishConfigInvalidation(key);
            return { success: false, error: COMMIT_UNKNOWN, indeterminate: true };
          }
          logger.error("Config reset failed", {
            key,
            error: err instanceof Error ? err.message : String(err),
            route: "platform/auth/platform-config",
          });
          return { success: false, error: STORAGE_FAILURE };
        }
        cache.delete(cacheKey(key));
        await publishConfigInvalidation(key);
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
