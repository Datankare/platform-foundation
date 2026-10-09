/**
 * GuestUsageStore conformance (ADR-027): the memory store, and the Supabase store against a
 * PostgREST emulation of migration 037 (guest_usage + guest_allowance_consume).
 */
import { runGuestUsageStoreContract } from "./contract/guest-usage-store-contract";
import {
  MemoryGuestUsageStore,
  SupabaseGuestUsageStore,
} from "@/platform/auth/guest-allowance";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

jest.mock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: jest.fn() }));
const mockFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;

/** Emulates the table and the SQL function's conditional upsert (one statement, atomic). */
function emulatePostgrest(): void {
  const rows = new Map<string, number>();
  mockFetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), { status });
    if (url.pathname.endsWith("/rpc/guest_allowance_consume")) {
      const { p_guest_id, p_limit } = JSON.parse(String(init?.body)) as {
        p_guest_id: string;
        p_limit: number;
      };
      const current = rows.get(p_guest_id) ?? 0;
      if (current >= p_limit) return json(200, [{ allowed: false, used: current }]);
      rows.set(p_guest_id, current + 1);
      return json(200, [{ allowed: true, used: current + 1 }]);
    }
    if (url.pathname.endsWith("/guest_usage") && init?.method === "GET") {
      const id = (url.searchParams.get("guest_id") ?? "").replace(/^eq\./, "");
      return json(200, rows.has(id) ? [{ translations_used: rows.get(id) }] : []);
    }
    if (url.pathname.endsWith("/guest_usage") && init?.method === "DELETE") {
      rows.clear();
      return new Response(null, { status: 204 });
    }
    return json(404, { message: "not emulated" });
  });
}

describe("MemoryGuestUsageStore — conformance", () => {
  runGuestUsageStoreContract({ makeStore: () => new MemoryGuestUsageStore() });
});

describe("SupabaseGuestUsageStore — conformance (PostgREST emulation)", () => {
  runGuestUsageStoreContract({
    makeStore: () => {
      emulatePostgrest();
      return new SupabaseGuestUsageStore("https://x.supabase.co", "key");
    },
  });
});
