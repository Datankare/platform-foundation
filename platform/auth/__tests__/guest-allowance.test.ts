/**
 * ADR-050 D4 / TASK-099 — governed guest allowance: config clamp, stores, enforcement.
 */
import {
  GUEST_ALLOWANCE_DEFAULT,
  MemoryGuestUsageStore,
  SupabaseGuestUsageStore,
  enforceGuestAllowance,
  getGuestTranslateAllowance,
  getGuestUsageStore,
  setGuestUsageStore,
} from "@/platform/auth/guest-allowance";
import { newGuestId } from "@/platform/auth/guest-token";
import { getConfig } from "@/platform/auth/platform-config";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

jest.mock("@/platform/auth/platform-config", () => ({ getConfig: jest.fn() }));
jest.mock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  mockGetConfig.mockReset();
  mockFetch.mockReset();
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

describe("SupabaseGuestUsageStore", () => {
  const store = new SupabaseGuestUsageStore("https://x.supabase.co/", "key");

  it("consumes through the atomic RPC", async () => {
    mockFetch.mockResolvedValueOnce(res(200, [{ allowed: true, used: 2 }]));
    await expect(store.consume("guest_a", 5)).resolves.toEqual({
      allowed: true,
      used: 2,
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://x.supabase.co/rest/v1/rpc/guest_allowance_consume");
    expect(JSON.parse(String(init?.body))).toEqual({ p_guest_id: "guest_a", p_limit: 5 });
    expect(init).toMatchObject({ maxRetries: 0 });
  });

  it("accepts a single-object payload and reports a refusal", async () => {
    mockFetch.mockResolvedValueOnce(res(200, { allowed: false, used: 5 }));
    await expect(store.consume("guest_a", 5)).resolves.toEqual({
      allowed: false,
      used: 5,
    });
  });

  it("throws on an HTTP error or an empty payload", async () => {
    mockFetch.mockResolvedValueOnce(res(500, { message: "boom" }));
    await expect(store.consume("guest_a", 5)).rejects.toThrow(/consume failed \(500\)/);
    mockFetch.mockResolvedValueOnce(res(200, []));
    await expect(store.consume("guest_a", 5)).rejects.toThrow(/no row/);
  });

  it("reads and resets", async () => {
    mockFetch.mockResolvedValueOnce(res(200, [{ translations_used: 4 }]));
    await expect(store.used("guest_a")).resolves.toBe(4);
    mockFetch.mockResolvedValueOnce(res(200, []));
    await expect(store.used("guest_b")).resolves.toBe(0);
    mockFetch.mockResolvedValueOnce(res(503, "x"));
    await expect(store.used("guest_c")).rejects.toThrow(/read failed/);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(store.reset()).resolves.toBeUndefined();
    mockFetch.mockResolvedValueOnce(res(400, "x"));
    await expect(store.reset()).rejects.toThrow(/reset failed/);
  });
});

describe("enforceGuestAllowance", () => {
  it("users are not limited", async () => {
    const out = await enforceGuestAllowance({
      kind: "user",
      id: "u1",
      user: { sub: "u1" } as never,
    });
    expect(out).toEqual({ remaining: null });
    expect(mockGetConfig).not.toHaveBeenCalled();
  });

  it("refuses a guest actor whose id is not namespaced", async () => {
    const out = await enforceGuestAllowance({ kind: "guest", id: "u1", expiresAt: 0 });
    expect(out.error?.status).toBe(401);
  });

  it("counts a guest and reports what remains", async () => {
    mockGetConfig.mockResolvedValue(2 as never);
    const actor = { kind: "guest" as const, id: newGuestId(), expiresAt: 0 };
    await expect(enforceGuestAllowance(actor)).resolves.toEqual({ remaining: 1 });
    await expect(enforceGuestAllowance(actor)).resolves.toEqual({ remaining: 0 });
    const third = await enforceGuestAllowance(actor);
    expect(third.error?.status).toBe(403);
  });
});
