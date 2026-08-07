/**
 * @jest-environment node
 */
/**
 * ActivityStateStore contract — Supabase reference arm (ADR-027).
 *
 * The arm this store never had. It could not have one while it was built on the Supabase JS
 * client: a fetch-level fake cannot intercept that client, so nothing exercised the store,
 * and it shipped dead for a sprint (TASK-066). On raw fetch it runs against an in-memory
 * PostgREST exactly as its siblings do.
 *
 * The fake applies PATCH only to rows matching EVERY filter, which is what makes the version
 * CAS real here rather than simulated — a stale version matches nothing and returns no rows.
 *
 * Gotcha 66 still applies: this proves the store self-consistent, not schema-conformant.
 */

import { runAppStateStoreContract } from "./contract/app-state-store-contract";
import { SupabaseActivityStateStore } from "@/platform/app-framework/supabase-state-store";

type Row = Record<string, unknown>;

let rows: Row[] = [];

function applyFilters(all: Row[], params: URLSearchParams): Row[] {
  return all.filter((row) => {
    for (const [k, v] of params.entries()) {
      if (k === "select" || k === "order" || k === "limit") continue;
      if (v.startsWith("eq.")) {
        if (String(row[k]) !== v.slice(3)) return false;
      }
    }
    return true;
  });
}

function resp(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const originalFetch = global.fetch;

beforeEach(() => {
  rows = [];
});

beforeAll(() => {
  global.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = new URL(String(input));
      const table = u.pathname.split("/rest/v1/")[1] ?? "";
      if (table !== "app_sessions") return resp({}, 404) as unknown as Response;

      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};

      if (method === "POST") {
        // Primary-key violation, as Postgres would: creating over an existing session
        // would silently discard its state and its history.
        if (rows.some((r) => r.id === body.id)) {
          return resp(
            { code: "23505", message: "duplicate key value violates unique constraint" },
            409
          ) as unknown as Response;
        }
        rows.push({ ...body, produced_by: null });
        return resp([rows[rows.length - 1]], 201) as unknown as Response;
      }

      if (method === "PATCH") {
        // The CAS lives here: version=eq.N is one of the filters, so a stale version
        // matches nothing and the store sees zero rows returned.
        const matched = applyFilters(rows, u.searchParams);
        for (const row of matched) {
          for (const [k, v] of Object.entries(body)) row[k] = v;
        }
        return resp(matched.map((r) => ({ ...r }))) as unknown as Response;
      }

      if (method === "DELETE") {
        const matched = applyFilters(rows, u.searchParams);
        rows = rows.filter((r) => !matched.includes(r));
        return resp([]) as unknown as Response;
      }

      return resp(
        applyFilters(rows, u.searchParams).map((r) => ({ ...r }))
      ) as unknown as Response;
    }
  ) as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("ActivityStateStore contract — Supabase (PF reference impl)", () => {
  runAppStateStoreContract({
    makeStore: () =>
      new SupabaseActivityStateStore("https://test.supabase.co", "test-service-key"),
  });
});
