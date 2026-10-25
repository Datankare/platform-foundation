/**
 * @jest-environment node
 */
/**
 * CacheProvider contract — the Valkey arm (ADR-027, ADR-055 D4; review 9 M5)
 *
 * A container deployment shares its cache through its own Valkey or Redis (CACHE_PROVIDER=valkey):
 * a per-instance cache is refused, since revocations are published through the cache to every
 * instance. Here, against a real server spawned over TLS (helpers/valkey-server.ts):
 *   - the conformance kit passes;
 *   - TLS is verify-full: an unknown CA is refused, and so is a name the certificate does not
 *     carry; redis:// (clear text) is refused unless a local or CI run allows it;
 *   - a revocation published on one instance voids a remembered verification on another (two
 *     connections, two verifiers — two instances).
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import { runCacheProviderContract } from "./contract/cache-provider-contract";
import {
  ValkeyCacheProvider,
  valkeyConnectionOptions,
} from "@/platform/cache/valkey-cache";
import { createCacheProvider } from "@/platform/cache";
import {
  TokenVerifier,
  revokeTokenVerification,
  type ProviderOutcome,
} from "@/platform/auth/token-verification";
import type { TokenPayload } from "@/platform/auth/types";
import { startValkey, valkeyDescribe, type RunningValkey } from "./helpers/valkey-server";

let server: RunningValkey;
const open: ValkeyCacheProvider[] = [];
function provider(
  over: Partial<ConstructorParameters<typeof ValkeyCacheProvider>[0]> = {}
) {
  const p = new ValkeyCacheProvider({
    url: server.url,
    caCert: server.caPem,
    namespace: "contract:",
    timeoutMs: 2000,
    ...over,
  });
  open.push(p);
  return p;
}

describe("connection options (no server needed)", () => {
  it("rediss:// is TLS verify-full: the URL's host is the name checked, never unverified", () => {
    const { options } = valkeyConnectionOptions({
      url: "rediss://:pw@cache.internal:6380",
    });
    expect(options.tls).toEqual({ servername: "cache.internal" });
    expect(JSON.stringify(options)).not.toMatch(/rejectUnauthorized/);
  });

  it("a private CA is passed as the only trust anchor given", () => {
    const { options } = valkeyConnectionOptions({
      url: "rediss://h:1",
      caCert: "-----BEGIN CERTIFICATE-----x",
    });
    expect(options.tls).toEqual({
      servername: "h",
      ca: ["-----BEGIN CERTIFICATE-----x"],
    });
  });

  it("redis:// is refused unless allowed (local/CI); other schemes always", () => {
    expect(() => valkeyConnectionOptions({ url: "redis://h:6379" })).toThrow(
      /rediss:\/\//
    );
    expect(
      valkeyConnectionOptions({ url: "redis://h:6379", allowPlaintext: true }).options.tls
    ).toBeUndefined();
    expect(() => valkeyConnectionOptions({ url: "https://h" })).toThrow(/rediss:\/\//);
    expect(() => valkeyConnectionOptions({ url: "not a url" })).toThrow(/not a URL/);
  });

  // Review 10 M6: ioredis reads a connection URL's query parameters as options, overriding the
  // ones passed beside it (the reviewer's review10/__tests__/r10/ioredis-url-override.js:
  // `?tls=` dropped TLS, `?commandTimeout=0` unbounded every command). The URL is parsed here and
  // only explicit options reach the client; a query string or fragment is refused.
  it.each([
    "rediss://cache.internal:6380/?tls=",
    "rediss://cache.internal:6380/?tls=x",
    "rediss://cache.internal:6380/?commandTimeout=0",
    "rediss://cache.internal:6380/?maxRetriesPerRequest=null&commandTimeout=0",
    "rediss://cache.internal:6380?tls=",
    "rediss://cache.internal:6380/#frag",
    "rediss://cache.internal:6380/0?",
  ])("a query string or fragment is refused: %s", (url) => {
    expect(() => valkeyConnectionOptions({ url })).toThrow(/query string or fragment/);
    expect(() => new ValkeyCacheProvider({ url })).toThrow(/query string or fragment/);
  });

  it("host, port, user, password and database are passed explicitly, with TLS and the timeout", () => {
    const { options } = valkeyConnectionOptions({
      url: "rediss://app%40x:p%3Aw@cache.internal:6380/3",
      timeoutMs: 1234,
    });
    expect(options).toMatchObject({
      host: "cache.internal",
      port: 6380,
      username: "app@x",
      password: "p:w",
      db: 3,
      commandTimeout: 1234,
      connectTimeout: 1234,
      maxRetriesPerRequest: 1,
      tls: { servername: "cache.internal" },
    });
    expect(valkeyConnectionOptions({ url: "rediss://h" }).options).toMatchObject({
      port: 6379,
      db: 0,
    });
    expect(() => valkeyConnectionOptions({ url: "rediss://h:1/x" })).toThrow(
      /database number/
    );
  });

  it("the client a provider builds keeps TLS and the command timeout (nothing in the URL overrides them)", async () => {
    const p = new ValkeyCacheProvider({
      url: "rediss://cache.internal:6380/2",
      caCert: "PEM",
      timeoutMs: 5000,
    });
    const client = (p as unknown as { client: { options: Record<string, unknown> } })
      .client;
    expect(client.options.tls).toEqual({ servername: "cache.internal", ca: ["PEM"] });
    expect(client.options.commandTimeout).toBe(5000);
    expect(client.options.maxRetriesPerRequest).toBe(1);
    expect(client.options.host).toBe("cache.internal");
    expect(client.options.port).toBe(6380);
    expect(client.options.db).toBe(2);
    await p.close();
  });

  it("CACHE_PROVIDER=valkey without VALKEY_URL fails closed", () => {
    const saved = { ...process.env };
    try {
      process.env.CACHE_PROVIDER = "valkey";
      delete process.env.VALKEY_URL;
      expect(() => createCacheProvider()).toThrow(/VALKEY_URL is not set/);
    } finally {
      process.env = saved;
    }
  });
});

valkeyDescribe("against a real server, over TLS", () => {
  beforeAll(async () => {
    server = await startValkey();
  }, 30_000);
  afterAll(async () => {
    await Promise.all(open.map((p) => p.close()));
    await server?.stop();
  });

  describe("the conformance kit", () => {
    runCacheProviderContract({ makeProvider: () => provider() });
  });

  it("is selected by CACHE_PROVIDER=valkey with VALKEY_URL", async () => {
    const saved = { ...process.env };
    try {
      process.env.CACHE_PROVIDER = "valkey";
      process.env.VALKEY_URL = server.url;
      process.env.VALKEY_CA_CERT = server.caPem;
      const p = createCacheProvider();
      open.push(p as ValkeyCacheProvider);
      expect(p.name).toBe("valkey");
      expect((await p.health()).connected).toBe(true);
    } finally {
      process.env = saved;
    }
  });

  it("TTLs expire, NX keeps the first value, and clear stays inside its namespace", async () => {
    const a = provider({ namespace: "ns*a:" });
    const b = provider({ namespace: "ns*b:" });
    await a.set("k", 1, { ttlSeconds: 1 });
    await a.set("k", 2, { onlyIfAbsent: true });
    expect(await a.get("k")).toBe(1);
    await b.set("k", "other");
    await a.clear();
    expect(await b.get("k")).toBe("other");
    await a.set("t", "x", { ttlSeconds: 1 });
    await new Promise((r) => setTimeout(r, 1_300));
    expect(await a.get("t")).toBeNull();
  });

  it("an unknown CA is refused (no unverified TLS)", async () => {
    const p = provider({ caCert: undefined, timeoutMs: 1000 });
    expect((await p.health()).connected).toBe(false);
  });

  it("a name the certificate does not carry is refused (verify-full)", async () => {
    const p = provider({
      url: `rediss://:${server.password}@127.0.0.1:${server.port}`,
      timeoutMs: 1000,
    });
    expect((await p.health()).connected).toBe(false);
  });

  it("a wrong password is refused", async () => {
    const p = provider({
      url: `rediss://:wrong@localhost:${server.port}`,
      timeoutMs: 1000,
    });
    await expect(p.get("x")).rejects.toThrow();
  });

  it("revocation stamps reach every instance: one instance's revocation voids another's entry", async () => {
    const T0 = 1_800_000_000_000;
    const payload = {
      sub: "user-1",
      email: "u@x.y",
      emailVerified: true,
      iat: 0,
      exp: T0 / 1000 + 3600,
      mfaEnabled: true,
    } as TokenPayload;
    const claims = { exp: T0 / 1000 + 3600, subject: "user-1" };
    const cacheA = provider({ namespace: "rv9:" });
    const cacheB = provider({ namespace: "rv9:" });
    const settings = async () => ({ freshSeconds: 30, graceSeconds: 300 });
    const a = new TokenVerifier({ cache: () => cacheA, settings, now: () => T0 });
    const b = new TokenVerifier({ cache: () => cacheB, settings, now: () => T0 });
    const ask = jest.fn(async (): Promise<ProviderOutcome> => ({
      kind: "valid",
      payload,
    }));
    await a.verify("tok", claims, ask);
    // B, another instance, is answered from the shared entry: no second GetUser.
    expect(await b.verify("tok", claims, ask)).toEqual(payload);
    expect(ask).toHaveBeenCalledTimes(1);
    // Revoked on B; A's next request does not use the entry.
    await revokeTokenVerification("user-1", cacheB);
    await a.verify("tok", claims, ask);
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
