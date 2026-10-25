/**
 * platform/cache/valkey-cache.ts — The shared cache over the Redis protocol: Valkey, Redis,
 * ElastiCache, Memorystore (ADR-055 D4; review 9 M5)
 *
 * A deployment shares its cache, because sign-outs, role and MFA changes and permission
 * invalidations are published through it to every instance (review 8 L3): a per-instance cache
 * is refused outside local and CI runs. Upstash (REST) serves Vercel; a container host runs its
 * own Valkey or Redis next to the app — this provider, selected by CACHE_PROVIDER=valkey with
 * VALKEY_URL.
 *
 *   transport  rediss:// — TLS, the server's certificate verified against the system CAs (or
 *              VALKEY_CA_CERT, a PEM bundle, for a private CA) and its name against the URL's
 *              host (verify-full). redis:// (plain TCP) only for a local or CI run, where the
 *              environment contract allows it.
 *   commands   one connection per instance (ioredis, pinned), opened on first use; every command
 *              bounded by the timeout (default 5 s) and retried by nobody underneath — the caller
 *              decides (a cache error is a miss for reads, logged for writes).
 *   semantics  the CacheProvider contract (__tests__/contract/cache-provider-contract.ts), as
 *              the Upstash provider: JSON values, namespaced keys, EX TTLs, NX, SCAN-based clear.
 *
 * @module platform/cache
 */

import Redis, { type RedisOptions } from "ioredis";
import { GuardedValkeyConnector } from "./valkey-connector";
import { parseValkeyUrl } from "./valkey-url";
import type {
  CacheGetOptions,
  CacheHealthStatus,
  CacheProvider,
  CacheSetOptions,
} from "./types";

export interface ValkeyCacheConfig {
  /**
   * rediss://[user:password@]host:port[/db] — redis:// only with allowPlaintext. No query string
   * or fragment (refused: ioredis would read it as options overriding TLS and timeouts).
   */
  url: string;
  /** PEM bundle of the CA that signed the server's certificate (a private CA). */
  caCert?: string;
  /** Allow redis:// (plain TCP) — a local or CI run only (the environment contract). */
  allowPlaintext?: boolean;
  /** Key namespace prefix. Default: "pf:" */
  namespace?: string;
  /** Default TTL in seconds. Default: 3600 */
  defaultTTLSeconds?: number;
  /** Connect and command timeout in ms. Default: 5000 */
  timeoutMs?: number;
}

/**
 * The connection options for `config`: TLS verify-full for rediss://; refused otherwise.
 *
 * The URL is parsed here, never handed to the client (review 10 M6): ioredis reads query
 * parameters of a connection URL as options, and they override the ones passed beside it —
 * `?tls=` turned TLS off, `?commandTimeout=0` removed the bound on every command. A query string
 * or fragment is therefore refused, and the host, port, user, password and database are passed
 * explicitly with the TLS options. The rules are platform/cache/valkey-url.ts's, which the
 * environment contract applies at boot too (review 11 L-6).
 */
export function valkeyConnectionOptions(config: ValkeyCacheConfig): {
  options: RedisOptions;
} {
  // The coded refusal (ValkeyUrlError, config.valkey_url_invalid) for any URL it will not use.
  const endpoint = parseValkeyUrl(config.url, config.allowPlaintext === true);
  const timeoutMs = config.timeoutMs ?? 5000;
  const options: RedisOptions = {
    host: endpoint.host,
    port: endpoint.port,
    ...(endpoint.username !== undefined ? { username: endpoint.username } : {}),
    ...(endpoint.password !== undefined ? { password: endpoint.password } : {}),
    db: endpoint.db,
    lazyConnect: true,
    connectTimeout: timeoutMs,
    commandTimeout: timeoutMs,
    // A command is not retried underneath the caller: one reconnect attempt at most.
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    // Every error on the socket handled for its whole life: a TLS alert arriving after the
    // first error would otherwise be thrown as an uncaught exception (valkey-connector.ts).
    Connector: GuardedValkeyConnector,
  };
  if (endpoint.tls) {
    options.tls = {
      // verify-full: the certificate chain against the system CAs (or the given CA), and the
      // name against the URL's host. Never disabled.
      servername: endpoint.host,
      ...(config.caCert ? { ca: [config.caCert] } : {}),
    };
  }
  return { options };
}

/** A glob pattern matching exactly the keys that start with `prefix`. */
function globPrefix(prefix: string): string {
  return `${prefix.replace(/[\\*?[\]]/g, "\\$&")}*`;
}

export class ValkeyCacheProvider implements CacheProvider {
  readonly name = "valkey";
  private readonly client: Redis;
  private readonly namespace: string;
  private readonly defaultTTLSeconds: number;
  private connecting: Promise<void> | undefined;

  constructor(config: ValkeyCacheConfig) {
    // Options only, never the URL: nothing in VALKEY_URL can override them (review 10 M6).
    const { options } = valkeyConnectionOptions(config);
    this.client = new Redis(options);
    // Errors reach the caller through its command; the event is noted, never thrown.
    this.client.on("error", () => undefined);
    this.namespace = config.namespace ?? "pf:";
    this.defaultTTLSeconds = config.defaultTTLSeconds ?? 3600;
  }

  private key(key: string): string {
    return `${this.namespace}${key}`;
  }

  /** Open the connection once (single flight); later calls reuse it. */
  private async ready(): Promise<Redis> {
    if (this.client.status === "wait") {
      this.connecting ??= this.client.connect().finally(() => {
        this.connecting = undefined;
      });
    }
    if (this.connecting) await this.connecting;
    return this.client;
  }

  async get<T = unknown>(key: string, options?: CacheGetOptions): Promise<T | null> {
    const client = await this.ready();
    const k = this.key(key);
    const raw = await client.get(k);
    if (raw === null) return null;
    if (options?.slidingExpiry) {
      const ttl = await client.ttl(k);
      if (ttl > 0) await client.expire(k, ttl);
    }
    return this.deserialize<T>(raw);
  }

  async set<T = unknown>(
    key: string,
    value: T,
    options?: CacheSetOptions
  ): Promise<void> {
    const client = await this.ready();
    const args: (string | number)[] = [this.key(key), JSON.stringify(value)];
    const ttl = options?.ttlSeconds ?? this.defaultTTLSeconds;
    if (ttl > 0) args.push("EX", ttl);
    if (options?.onlyIfAbsent) args.push("NX");
    await client.call("SET", ...args);
  }

  async delete(key: string): Promise<boolean> {
    const client = await this.ready();
    return (await client.del(this.key(key))) === 1;
  }

  async has(key: string): Promise<boolean> {
    const client = await this.ready();
    return (await client.exists(this.key(key))) === 1;
  }

  async clear(): Promise<void> {
    const client = await this.ready();
    let cursor = "0";
    do {
      const [next, keys] = await client.scan(
        cursor,
        "MATCH",
        globPrefix(this.namespace),
        "COUNT",
        100
      );
      cursor = next;
      if (keys.length > 0) await client.del(...keys);
    } while (cursor !== "0");
  }

  async health(): Promise<CacheHealthStatus> {
    const start = Date.now();
    try {
      const client = await this.ready();
      const pong = await client.ping();
      return {
        connected: pong === "PONG",
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

  /** Close the connection (ADR-055 D5 — the instance is stopping). */
  async close(): Promise<void> {
    if (this.client.status === "wait" || this.client.status === "end") {
      this.client.disconnect();
      return;
    }
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  private deserialize<T>(raw: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }
}
