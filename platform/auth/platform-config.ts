/**
 * platform/auth/platform-config.ts — Runtime configuration service
 *
 * Read/write platform_config table. All mutations are audit-logged.
 * Includes an in-memory cache (60s TTL) to avoid DB round-trips
 * on every request for frequently-read config like feature flags.
 *
 * Sprint 7b, Task 7b.1
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";

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

/**
 * Set a config value. Creates or updates the key.
 * Clears the cache entry and writes an audit log.
 */
export async function setConfig(
  key: string,
  value: unknown,
  actorId: string,
  description?: string,
  category?: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseServiceClient();

  const upsertData: Record<string, unknown> = {
    key,
    value: JSON.stringify(value),
    updated_by: actorId,
    updated_at: new Date().toISOString(),
  };

  if (description !== undefined) upsertData.description = description;
  if (category !== undefined) upsertData.category = category;

  const { error } = await (supabase
    .from("platform_config" as never)
    .upsert(upsertData as never, { onConflict: "key" }) as unknown as Promise<{
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

  // Invalidate cache
  cache.delete(key);

  await writeAuditLog({
    action: "admin_action",
    actorId,
    details: { type: "config_updated", key, value },
  });

  return { success: true };
}

/**
 * Delete a config key.
 */
export async function deleteConfig(
  key: string,
  actorId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseServiceClient();

  const { error } = await supabase.from("platform_config").delete().eq("key", key);

  if (error) {
    logger.error("Config delete failed", {
      key,
      error: error.message,
      route: "platform/auth/platform-config",
    });
    return { success: false, error: error.message };
  }

  cache.delete(key);

  await writeAuditLog({
    action: "admin_action",
    actorId,
    details: { type: "config_deleted", key },
  });

  return { success: true };
}
