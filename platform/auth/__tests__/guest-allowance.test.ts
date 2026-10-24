/**
 * ADR-050 D4 / TASK-099 — governed guest allowance: config clamp, stores, enforcement.
 */
import {
  GUEST_ALLOWANCE_DEFAULT,
  MemoryGuestUsageStore,
  PostgresGuestUsageStore,
  enforceGuestAllowance,
  getGuestTranslateAllowance,
  getGuestUsageStore,
  setGuestUsageStore,
} from "@/platform/auth/guest-allowance";
import { newGuestId } from "@/platform/auth/guest-token";
import { getConfig } from "@/platform/auth/platform-config";
import { withTenantTx } from "@/platform/data";
import { DEFAULT_TENANT_ID } from "@/platform/providers/environment-contract";
import { runWithTenant } from "@/platform/tenancy/context";

jest.mock("@/platform/auth/platform-config", () => ({ getConfig: jest.fn() }));
// The Postgres store's SQL is proven against the database (__tests__/db/guest-usage.db.test.ts);
// here only what a database cannot be made to return.
jest.mock("@/platform/data", () => ({ withTenantTx: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockTx = withTenantTx as jest.MockedFunction<typeof withTenantTx>;

beforeEach(() => {
  mockGetConfig.mockReset();
  mockTx.mockReset();
  setGuestUsageStore(new MemoryGuestUsageStore());
});

describe("getGuestTranslateAllowance", () => {
  it.each([
    [5, 5],
    [1, 1],
    [10, 10],
    [0, 1],
    [-3, 1],
    [11, 10],
    [3.9, 3],
    ["7", 7],
    ["abc", GUEST_ALLOWANCE_DEFAULT],
    [null, 1],
  ])("governed %p → %p", async (value, want) => {
    mockGetConfig.mockResolvedValue(value as never);
    await expect(getGuestTranslateAllowance()).resolves.toBe(want);
  });

  it("an unreadable config falls back to the default", async () => {
    mockGetConfig.mockRejectedValue(new Error("no db"));
    await expect(getGuestTranslateAllowance()).resolves.toBe(GUEST_ALLOWANCE_DEFAULT);
  });
});

describe("MemoryGuestUsageStore", () => {
  it("counts to the limit and never past it, even under concurrency", async () => {
    const store = new MemoryGuestUsageStore();
    const id = newGuestId();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.consume(id, 3))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    await expect(store.used(id)).resolves.toBe(3);
    await store.reset();
    await expect(store.used(id)).resolves.toBe(0);
  });

  it("is the default store", () => {
    expect(getGuestUsageStore()).toBeInstanceOf(MemoryGuestUsageStore);
  });
});

describe("MemoryGuestUsageStore — tenants", () => {
  it("keeps each tenant's counts apart, and reset clears only the current tenant's", async () => {
    const store = new MemoryGuestUsageStore();
    const id = newGuestId();
    const a = {
      tenantId: "00000000-0000-4000-8000-00000000000a",
      mode: "shared" as const,
    };
    const b = {
      tenantId: "00000000-0000-4000-8000-00000000000b",
      mode: "shared" as const,
    };
    await runWithTenant(a, () => store.consume(id, 1));
    await expect(runWithTenant(b, () => store.consume(id, 1))).resolves.toEqual({
      allowed: true,
      used: 1,
    });
    await runWithTenant(b, () => store.reset());
    await expect(runWithTenant(a, () => store.used(id))).resolves.toBe(1);
    await expect(runWithTenant(b, () => store.used(id))).resolves.toBe(0);
  });
});

describe("PostgresGuestUsageStore", () => {
  it("throws when the consume function returns no row", async () => {
    mockTx.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(new PostgresGuestUsageStore().consume(newGuestId(), 5)).rejects.toThrow(
      /no row/
    );
  });

  it("a store failure is a logged internal error, never an uncounted call", async () => {
    mockGetConfig.mockResolvedValue(5 as never);
    mockTx.mockRejectedValueOnce(new Error("connection refused"));
    setGuestUsageStore(new PostgresGuestUsageStore());
    const out = await enforceGuestAllowance({
      kind: "guest",
      id: newGuestId(),
      tenantId: DEFAULT_TENANT_ID,
      expiresAt: 0,
    });
    expect(out.error?.status).toBe(500);
  });
});

describe("enforceGuestAllowance", () => {
  it("users are not limited", async () => {
    const out = await enforceGuestAllowance({
      kind: "user",
      id: "u1",
      tenantId: DEFAULT_TENANT_ID,
      user: { sub: "u1" } as never,
    });
    expect(out).toEqual({ remaining: null });
    expect(mockGetConfig).not.toHaveBeenCalled();
  });

  it("refuses a guest actor whose id is not namespaced", async () => {
    const out = await enforceGuestAllowance({
      kind: "guest",
      id: "u1",
      tenantId: DEFAULT_TENANT_ID,
      expiresAt: 0,
    });
    expect(out.error?.status).toBe(401);
  });

  it("counts a guest and reports what remains", async () => {
    mockGetConfig.mockResolvedValue(2 as never);
    const actor = {
      kind: "guest" as const,
      id: newGuestId(),
      tenantId: DEFAULT_TENANT_ID,
      expiresAt: 0,
    };
    await expect(enforceGuestAllowance(actor)).resolves.toEqual({ remaining: 1 });
    await expect(enforceGuestAllowance(actor)).resolves.toEqual({ remaining: 0 });
    const third = await enforceGuestAllowance(actor);
    expect(third.error?.status).toBe(403);
  });
});
