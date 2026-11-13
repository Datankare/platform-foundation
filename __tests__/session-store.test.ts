/**
 * MemorySessionStore: the conformance kit, tenants kept apart, and which store a deployment gets
 * (ADR-057 D1): Postgres with a database, memory without — and never memory in production.
 */

import { runSessionStoreContract } from "./contract/session-store-contract";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";
import {
  MemorySessionStore,
  PostgresSessionStore,
  getSessionStore,
  type NewSession,
} from "@/platform/auth/session-store";
import { resetSingleton } from "@/platform/kernel/singleton";
import { runWithTenant } from "@/platform/tenancy/context";
import type { SealedTokens } from "@/platform/auth/session-vault";
import { createHash, randomUUID } from "node:crypto";

const idHashFor = (key: string) => createHash("sha256").update(key).digest("hex");
const record = (key: string): NewSession => ({
  idHash: idHashFor(key),
  kind: "user",
  subject: "user-a",
  method: "password",
  csrfToken: "c".repeat(43),
  sealedTokens: "v1.kit" as SealedTokens,
  createdAt: 1_800_000_000_000,
  lastSeenAt: 1_800_000_000_000,
});

describe("MemorySessionStore", () => {
  runSessionStoreContract({ makeStore: () => new MemorySessionStore() });

  runTenantIsolationContract({
    name: "sign-in sessions (memory)",
    makeStore: () => new MemorySessionStore(),
    createTenant: async () => {
      const ctx = { tenantId: randomUUID(), mode: "shared" as const };
      return { run: <T>(fn: () => T) => runWithTenant(ctx, fn) };
    },
    write: (store, key) => store.open(record(key)),
    read: async (store, key) => {
      const found = await store.find(idHashFor(key));
      return found && found.revokedAt === undefined ? found : null;
    },
    update: async (store, key) => {
      await store.revoke(idHashFor(key), "sign_out", Date.now());
    },
    remove: (store) => store.reset(),
    // Memory has a "no tenant" partition for unit tests (platform/tenancy/partition.ts).
    failsClosedWithoutTenant: false,
  });
});

describe("which session store a deployment gets", () => {
  const saved = { ...process.env };
  const setEnv = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else
        Object.defineProperty(process.env, k, {
          value: v,
          configurable: true,
          writable: true,
          enumerable: true,
        });
    }
  };
  beforeEach(() => resetSingleton("platform.auth.sessionStore"));
  afterEach(() => {
    setEnv({
      NODE_ENV: saved.NODE_ENV,
      DATABASE_URL: saved.DATABASE_URL,
      E2E_IN_MEMORY_STORES: saved.E2E_IN_MEMORY_STORES,
      DEPLOYMENT_HOST: saved.DEPLOYMENT_HOST,
    });
    resetSingleton("platform.auth.sessionStore");
  });

  it("memory without a database, outside production", () => {
    setEnv({ DATABASE_URL: undefined, NODE_ENV: "test" });
    expect(getSessionStore()).toBeInstanceOf(MemorySessionStore);
  });

  it("Postgres whenever there is a database", () => {
    setEnv({
      DATABASE_URL: "postgresql://app_tenant:x@localhost:5432/db",
      NODE_ENV: "test",
    });
    expect(getSessionStore()).toBeInstanceOf(PostgresSessionStore);
  });

  it("production without a database refuses in-memory sessions", () => {
    setEnv({
      DATABASE_URL: undefined,
      NODE_ENV: "production",
      E2E_IN_MEMORY_STORES: undefined,
    });
    expect(() => getSessionStore()).toThrow(/refusing in-memory sessions/);
  });

  it("the E2E opt-out is honoured only on a local or CI host", () => {
    setEnv({
      DATABASE_URL: undefined,
      NODE_ENV: "production",
      E2E_IN_MEMORY_STORES: "true",
      DEPLOYMENT_HOST: "vercel",
    });
    expect(() => getSessionStore()).toThrow(/refusing in-memory sessions/);
    resetSingleton("platform.auth.sessionStore");
    setEnv({ DEPLOYMENT_HOST: "ci" });
    expect(getSessionStore()).toBeInstanceOf(MemorySessionStore);
  });
});
