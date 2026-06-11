/**
 * CacheProvider contract — Redis reference arm (ADR-027).
 *
 * Runs the synced CacheProvider conformance kit against the real
 * RedisCacheProvider, backed by a faithful in-memory fake of the Upstash REST
 * command protocol (GET/SET/DEL/EXISTS/SCAN/PING over a Map). This exercises the
 * provider's command construction, namespacing, and serialize/deserialize path
 * against a real round-trip backend. Single synced arm.
 */

import { runCacheProviderContract } from "./contract/cache-provider-contract";
import { RedisCacheProvider } from "@/platform/cache/redis-cache";

const store = new Map<string, string>();

function runCmd(cmd: unknown[]): unknown {
  const op = String(cmd[0]).toUpperCase();
  switch (op) {
    case "SET":
      store.set(String(cmd[1]), String(cmd[2]));
      return "OK";
    case "GET":
      return store.has(String(cmd[1])) ? store.get(String(cmd[1])) : null;
    case "DEL": {
      let n = 0;
      for (const k of cmd.slice(1)) if (store.delete(String(k))) n++;
      return n;
    }
    case "EXISTS":
      return store.has(String(cmd[1])) ? 1 : 0;
    case "SCAN":
      return ["0", [...store.keys()]];
    case "PING":
      return "PONG";
    case "TTL":
      return store.has(String(cmd[1])) ? 100 : -2;
    case "EXPIRE":
      return 1;
    default:
      return null;
  }
}

const originalFetch = global.fetch;

beforeAll(() => {
  const fetchMock = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const parsed = JSON.parse(String(init?.body ?? "[]"));
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (url.endsWith("/pipeline")) {
        const results = (parsed as unknown[][]).map((c) => ({ result: runCmd(c) }));
        return ok(results) as unknown as Response;
      }
      return ok({ result: runCmd(parsed as unknown[]) }) as unknown as Response;
    }
  );
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("CacheProvider contract — Redis (PF reference impl)", () => {
  runCacheProviderContract({
    makeProvider: () =>
      new RedisCacheProvider({
        url: "https://test.upstash.io",
        token: "test-token",
      }),
  });
});
