/**
 * Redis Cache Provider.
 *
 * Designed for Upstash Redis (serverless, Vercel-native) but works
 * with any Redis that exposes a REST API or @upstash/redis-compatible client.
 *
 * Uses fetch-based HTTP calls (no native TCP sockets) so it works in
 * serverless/edge environments where persistent connections aren't available.
 *
 * Abstraction: consumers never import this directly — they use CacheProvider
 * from the barrel export. Swapping to Redis Cloud, ElastiCache, or Valkey
 * is a config change, not a code change.
 *
 * @module platform/cache
 * @see ADR-015 GenAI-Native Stack
 */

import type {
  CacheGetOptions,
  CacheHealthStatus,
  CacheProvider,
  CacheSetOptions,
} from "./types";

/** Redis command response from Upstash REST API */
interface RedisResponse<T = unknown> {
  result: T;
  error?: string;
}

export interface RedisCacheConfig {
  /** Upstash Redis REST URL (e.g., https://xxx.upstash.io) */
  url: string;
  /** Upstash Redis REST token */
  token: string;
  /** Key namespace prefix. Default: "pf:" */
  namespace?: string;
  /** Default TTL in seconds. Default: 3600 */
  defaultTTLSeconds?: number;
  /** Request timeout in ms. Default: 5000 */
  timeoutMs?: number;
}

export class RedisCacheProvider implements CacheProvider {
  readonly name = "redis";
  private readonly url: string;
  private readonly token: string;
  private readonly namespace: string;
  private readonly defaultTTLSeconds: number;
  private readonly timeoutMs: number;

  constructor(config: RedisCacheConfig) {
    if (!config.url || !config.token) {
      throw new Error(
        "RedisCacheProvider requires url and token. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN."
      );
    }
    this.url = config.url.replace(/\/$/, "");
    this.token = config.token;
    this.namespace = config.namespace ?? "pf:";
    this.defaultTTLSeconds = config.defaultTTLSeconds ?? 3600;
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  private prefixedKey(key: string): string {
    return `${this.namespace}${key}`;
  }

  /**
   * Execute a Redis command via Upstash REST API.
   * Uses fetch (no TCP) — works in edge/serverless.
   */
  private async execute<T = unknown>(command: string[]): Promise<RedisResponse<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.url}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "unknown error");
        throw new Error(`Redis HTTP ${response.status}: ${text}`);
      }

      return (await response.json()) as RedisResponse<T>;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Execute multiple commands in a single pipeline request.
   */
  private async pipeline<T = unknown>(commands: string[][]): Promise<RedisResponse<T>[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.url}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(commands),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "unknown error");
        throw new Error(`Redis pipeline HTTP ${response.status}: ${text}`);
      }

      return (await response.json()) as RedisResponse<T>[];
    } finally {
      clearTimeout(timeout);
    }
  }

  async get<T = unknown>(key: string, options?: CacheGetOptions): Promise<T | null> {
    const prefixed = this.prefixedKey(key);

    if (options?.slidingExpiry) {
      // GET + read remaining TTL, then refresh if exists
      const results = await this.pipeline([
        ["GET", prefixed],
        ["TTL", prefixed],
      ]);

      const value = results[0]?.result;
      const ttl = results[1]?.result as number;

      if (value === null || value === undefined) return null;

      // Refresh TTL if entry has one
      if (ttl > 0) {
        await this.execute(["EXPIRE", prefixed, String(ttl)]);
      }

      return this.deserialize<T>(value as string);
    }

    const response = await this.execute<string | null>(["GET", prefixed]);
    if (response.result === null || response.result === undefined) return null;

    return this.deserialize<T>(response.result);
  }

  async set<T = unknown>(
    key: string,
    value: T,
    options?: CacheSetOptions
  ): Promise<void> {
    const prefixed = this.prefixedKey(key);
    const serialized = this.serialize(value);
    const ttl = options?.ttlSeconds ?? this.defaultTTLSeconds;

    const command: string[] = ["SET", prefixed, serialized];

    if (ttl > 0) {
      command.push("EX", String(ttl));
    }

    if (options?.onlyIfAbsent) {
      command.push("NX");
    }

    await this.execute(command);
  }

  async delete(key: string): Promise<boolean> {
    const response = await this.execute<number>(["DEL", this.prefixedKey(key)]);
    return response.result === 1;
  }

  async has(key: string): Promise<boolean> {
    const response = await this.execute<number>(["EXISTS", this.prefixedKey(key)]);
    return response.result === 1;
  }

  async clear(): Promise<void> {
    // SCAN for all keys with our namespace prefix, then DEL in batches
    let cursor = "0";
    do {
      const response = await this.execute<[string, string[]]>([
        "SCAN",
        cursor,
        "MATCH",
        `${this.namespace}*`,
        "COUNT",
        "100",
      ]);

      cursor = response.result[0];
      const keys = response.result[1];

      if (keys.length > 0) {
        await this.execute(["DEL", ...keys]);
      }
    } while (cursor !== "0");
  }

  async health(): Promise<CacheHealthStatus> {
    const start = Date.now();
    try {
      const response = await this.execute<string>(["PING"]);
      return {
        connected: response.result === "PONG",
        latencyMs: Date.now() - start,
        provider: this.name,
      };
    } catch (error) {
      return {
        connected: false,
        latencyMs: Date.now() - start,
        provider: this.name,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  private serialize(value: unknown): string {
    return JSON.stringify(value);
  }

  private deserialize<T>(raw: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      // If it's not valid JSON, return as-is (plain string)
      return raw as unknown as T;
    }
  }
}
